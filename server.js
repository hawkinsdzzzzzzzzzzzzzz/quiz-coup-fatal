const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stringSimilarity = require('string-similarity');
const questionsList = require('./questions.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const salons = {};

function diffuserSalonsPublics() {
    const liste = [];
    for (let code in salons) {
        const s = salons[code];
        if (s.estPublic && !s.partieCommencee) {
            liste.push({ code: code, createur: s.pseudos[s.createur] || "Anonyme", mode: s.mode, nbJoueurs: s.joueurs.length });
        }
    }
    io.emit('maj_salons_publics', liste);
}

function tirerQuestion(salon) {
    if (salon.questionsRestantes.length === 0) salon.questionsRestantes = [...questionsList];
    const randomIndex = Math.floor(Math.random() * salon.questionsRestantes.length);
    const questionTiree = salon.questionsRestantes[randomIndex];
    salon.questionsRestantes.splice(randomIndex, 1);
    return questionTiree;
}

function demarrerChrono(io, codeSalon, salon) {
    clearInterval(salon.intervalle);
    salon.intervalle = setInterval(() => {
        if (salon.temps[salon.joueurActif] > 0) {
            salon.temps[salon.joueurActif] -= 1;
            io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
        }

        if (salon.temps[salon.joueurActif] <= 0) {
            clearInterval(salon.intervalle);

            if (salon.mode === 'buzzer') {
                salon.scores[salon.joueurActif] -= 5;
                const exJoueur = salon.joueurActif;
                salon.joueurActif = 'bloque';

                io.to(codeSalon).emit('message_serveur', `⏱️ Trop lent ! -5 pts pour ${salon.pseudos[exJoueur]}. Suivante...`);
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
                setTimeout(() => lancerProchainTour(io, codeSalon, salon), 2000);
            } else {
                // ÉLIMINATION EN MODE CLASSIQUE
                const joueurElimine = salon.joueurActif;

                io.to(codeSalon).emit('message_serveur', `👋 ${salon.pseudos[joueurElimine]} n'a plus de temps et est éliminé !`);

                // Envoie la pop-up uniquement au perdant
                io.to(joueurElimine).emit('afficher_ecran_defaite');

                // On le retire des joueurs actifs
                salon.ordreJoueurs = salon.ordreJoueurs.filter(id => id !== joueurElimine);

                // On recule l'index pour que le joueur suivant prenne la main correctement
                salon.indexTour -= 1;
                if (salon.indexTour < -1) salon.indexTour = -1;

                // Vérification de fin de partie
                if (salon.ordreJoueurs.length === 1 && salon.mode !== 'presentateur' && salon.joueurs.length > 1) {
                    io.to(codeSalon).emit('fin_partie', `🏆 Victoire de ${salon.pseudos[salon.ordreJoueurs[0]]} !`);
                } else if (salon.ordreJoueurs.length === 0) {
                    io.to(codeSalon).emit('fin_partie', `🏁 La partie est terminée !`);
                } else {
                    setTimeout(() => lancerProchainTour(io, codeSalon, salon), 2000);
                }
            }
        }
    }, 1000);
}

function lancerProchainTour(io, codeSalon, salon) {
    clearInterval(salon.intervalle);

    salon.votesSkip = [];
    io.to(codeSalon).emit('maj_votes_skip', { votes: 0, total: salon.ordreJoueurs.length });

    if (salon.mode === 'classique' || salon.mode === 'presentateur') {
        salon.indexTour = (salon.indexTour + 1) % salon.ordreJoueurs.length;
        salon.joueurActif = salon.ordreJoueurs[salon.indexTour];
    } else if (salon.mode === 'buzzer') {
        salon.joueurActif = null;
    }

    const questionTiree = tirerQuestion(salon);
    salon.reponsesAttendues = questionTiree.reponses;

    io.to(codeSalon).emit('nouvelle_question', {
        question: questionTiree.question,
        reponses: questionTiree.reponses,
        theme: questionTiree.theme,
        difficulte: questionTiree.difficulte,
        pseudoActif: salon.joueurActif ? salon.pseudos[salon.joueurActif] : null,
        mode: salon.mode,
        options: salon.options
    });

    io.to(codeSalon).emit('changement_tour', { idJoueurActif: salon.joueurActif });

    if (salon.joueurActif !== null && salon.mode !== 'buzzer') {
        demarrerChrono(io, codeSalon, salon);
    }
}

io.on('connection', (socket) => {
    socket.emit('maj_salons_publics', diffuserSalonsPublics());

    socket.on('rejoindre_salon', (data) => {
        if (!data) return;
        const { codeSalon, pseudo, tempsChoisi, modeChoisi, optionsBonus, estPublic } = data;

        socket.join(codeSalon);
        socket.pseudo = pseudo;
        socket.codeSalon = codeSalon;

        if (!salons[codeSalon]) {
            salons[codeSalon] = {
                joueurs: [], pseudos: {}, temps: {}, scores: {},
                tempsInitial: parseInt(tempsChoisi) || 60,
                mode: modeChoisi || 'classique',
                options: optionsBonus || { voirQuestions: false },
                estPublic: estPublic,
                intervalle: null, joueurActif: null,
                reponsesAttendues: [], votesSkip: [],
                partieCommencee: false, ordreJoueurs: [], indexTour: -1,
                createur: socket.id,
                questionsRestantes: [...questionsList]
            };
        }

        const salon = salons[codeSalon];
        const estPresentateur = (salon.mode === 'presentateur' && socket.id === salon.createur);

        if (!estPresentateur && !salon.joueurs.includes(socket.id)) {
            salon.joueurs.push(socket.id);
            salon.pseudos[socket.id] = pseudo;
            salon.temps[socket.id] = salon.tempsInitial;
            salon.scores[socket.id] = 0;
        } else if (estPresentateur) {
            salon.pseudos[socket.id] = pseudo + " (Présentateur)";
        }

        socket.emit('info_role', { estChef: salon.createur === socket.id, estPresentateur: estPresentateur, mode: salon.mode });
        io.to(codeSalon).emit('maj_joueurs', salon.joueurs.length);
        io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
        io.to(codeSalon).emit('maj_lobby', Object.values(salon.pseudos));
        diffuserSalonsPublics();
    });

    socket.on('lancer_partie', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || salon.partieCommencee || socket.id !== salon.createur) return;
        if (salon.joueurs.length < 1) return;

        salon.partieCommencee = true;
        salon.ordreJoueurs = [...salon.joueurs].sort(() => Math.random() - 0.5);
        salon.indexTour = -1;

        io.to(codeSalon).emit('partie_lancee');
        lancerProchainTour(io, codeSalon, salon);
        diffuserSalonsPublics();
    });

    socket.on('clic_buzzer', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || salon.mode !== 'buzzer' || salon.joueurActif !== null) return;
        if (!salon.ordreJoueurs.includes(socket.id) && salon.temps[socket.id] <= 0) return; // Un mort ne buzz pas

        salon.joueurActif = socket.id;
        io.to(codeSalon).emit('message_serveur', `🚨 ${salon.pseudos[socket.id]} a buzzé ! (5s)`);
        io.to(codeSalon).emit('changement_tour', { idJoueurActif: salon.joueurActif });

        let tempsRestant = 5;
        io.to(codeSalon).emit('tic_tac_buzzer', tempsRestant);

        clearInterval(salon.intervalle);
        salon.intervalle = setInterval(() => {
            tempsRestant -= 1;
            io.to(codeSalon).emit('tic_tac_buzzer', tempsRestant);

            if (tempsRestant <= 0) {
                clearInterval(salon.intervalle);
                salon.scores[salon.joueurActif] -= 5;
                const exJoueur = salon.joueurActif;
                salon.joueurActif = 'bloque';

                io.to(codeSalon).emit('message_serveur', `⏱️ Trop lent ! -5 pts pour ${salon.pseudos[exJoueur]}. Suivante...`);
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
                setTimeout(() => lancerProchainTour(io, codeSalon, salon), 2000);
            }
        }, 1000);
    });

    socket.on('proposer_reponse', (data) => {
        const { codeSalon, reponseJoueur } = data;
        const salon = salons[codeSalon];
        if (!salon || socket.id !== salon.joueurActif) return;

        let reponseValidee = false;
        for (let reponse of salon.reponsesAttendues) {
            if (stringSimilarity.compareTwoStrings(reponseJoueur.toLowerCase(), reponse.toLowerCase()) > 0.8) {
                reponseValidee = true; break;
            }
        }

        if (reponseValidee) {
            if (salon.mode === 'buzzer') {
                clearInterval(salon.intervalle);
                salon.scores[socket.id] += 10;
                salon.joueurActif = 'bloque';
            }
            io.to(codeSalon).emit('bonne_reponse', `✅ Bonne réponse de ${salon.pseudos[socket.id]} ! ${salon.mode === 'buzzer' ? '(+10 pts)' : ''}`);
            io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });

            if (salon.mode === 'buzzer') {
                setTimeout(() => lancerProchainTour(io, codeSalon, salon), 2000);
            } else {
                lancerProchainTour(io, codeSalon, salon);
            }
        } else {
            if (salon.mode === 'buzzer') {
                clearInterval(salon.intervalle);
                salon.scores[socket.id] -= 5;
                const exJoueur = socket.id;
                salon.joueurActif = 'bloque';

                socket.emit('mauvaise_reponse', "Faux ! -5 Points.");
                io.to(codeSalon).emit('message_serveur', `❌ ${salon.pseudos[exJoueur]} s'est trompé (-5 pts). Suivante...`);
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });

                setTimeout(() => lancerProchainTour(io, codeSalon, salon), 2000);
            } else {
                socket.emit('mauvaise_reponse', "Ce n'est pas ça, réessaie !");
            }
        }
    });

    socket.on('jugement_presentateur', (data) => {
        const { codeSalon, estCorrect } = data;
        const salon = salons[codeSalon];
        if (!salon || salon.mode !== 'presentateur' || socket.id !== salon.createur) return;

        if (estCorrect) {
            io.to(codeSalon).emit('bonne_reponse', `✅ Le présentateur a validé !`);
            lancerProchainTour(io, codeSalon, salon);
        } else {
            io.to(codeSalon).emit('mauvaise_reponse', "❌ FAUX ! Nouvelle question...");
            const questionTiree = tirerQuestion(salon);
            salon.reponsesAttendues = questionTiree.reponses;
            io.to(codeSalon).emit('nouvelle_question', {
                question: questionTiree.question,
                reponses: questionTiree.reponses,
                theme: questionTiree.theme,
                difficulte: questionTiree.difficulte,
                pseudoActif: salon.pseudos[salon.joueurActif],
                mode: salon.mode,
                options: salon.options
            });
        }
    });

    socket.on('skip_question', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon) return;

        if (salon.mode === 'buzzer') {
            if (salon.joueurActif !== null) return;

            if (!salon.votesSkip.includes(socket.id)) {
                salon.votesSkip.push(socket.id);
                io.to(codeSalon).emit('maj_votes_skip', { votes: salon.votesSkip.length, total: salon.ordreJoueurs.length });

                if (salon.votesSkip.length > salon.ordreJoueurs.length / 2) {
                    io.to(codeSalon).emit('message_serveur', `⏭️ Majorité atteinte ! On passe la question...`);
                    setTimeout(() => lancerProchainTour(io, codeSalon, salon), 1500);
                }
            }
        } else {
            if (socket.id !== salon.joueurActif && socket.id !== salon.createur) return;
            const questionTiree = tirerQuestion(salon);
            salon.reponsesAttendues = questionTiree.reponses;
            io.to(codeSalon).emit('nouvelle_question', {
                question: questionTiree.question,
                reponses: questionTiree.reponses,
                theme: questionTiree.theme,
                difficulte: questionTiree.difficulte,
                pseudoActif: salon.pseudos[salon.joueurActif],
                mode: salon.mode,
                options: salon.options
            });
        }
    });

    socket.on('en_train_de_taper', (data) => {
        if (!data) return;
        socket.to(data.codeSalon).emit('frappe_adversaire', { pseudo: socket.pseudo, texte: data.texte });
    });

    socket.on('disconnect', () => {
        const codeSalon = socket.codeSalon;
        if (codeSalon && salons[codeSalon]) {
            io.to(codeSalon).emit('message_serveur', `👋 ${socket.pseudo || 'Un joueur'} a quitté le salon.`);
            if (salons[codeSalon].temps[socket.id]) {
                delete salons[codeSalon].temps[socket.id];
                delete salons[codeSalon].pseudos[socket.id];
                delete salons[codeSalon].scores[socket.id];

                salons[codeSalon].votesSkip = salons[codeSalon].votesSkip.filter(id => id !== socket.id);
                salons[codeSalon].joueurs = salons[codeSalon].joueurs.filter(id => id !== socket.id);
                salons[codeSalon].ordreJoueurs = salons[codeSalon].ordreJoueurs.filter(id => id !== socket.id);

                io.to(codeSalon).emit('maj_temps', { temps: salons[codeSalon].temps, pseudos: salons[codeSalon].pseudos, scores: salons[codeSalon].scores });
                io.to(codeSalon).emit('maj_lobby', Object.values(salons[codeSalon].pseudos));

                if (salons[codeSalon].joueurs.length === 0 && salons[codeSalon].createur !== socket.id) {
                    delete salons[codeSalon];
                }
                diffuserSalonsPublics();
            }
        }
    });
});

server.listen(3000, () => { console.log('Serveur lancé !'); });