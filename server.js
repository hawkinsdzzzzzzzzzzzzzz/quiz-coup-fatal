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

// SYSTÈME DE TRANSITION (Évite les bugs de double-skip et affiche la réponse)
function declencherTransition(io, codeSalon, salon, message, delai = 4000) {
    if (salon.transitionEnCours) return; // Bloque toute autre action !
    salon.transitionEnCours = true;

    clearInterval(salon.intervalle);
    clearTimeout(salon.botTimeout);

    const vraieReponse = salon.reponsesAttendues[0] || "???";

    io.to(codeSalon).emit('message_serveur', message);
    io.to(codeSalon).emit('reponse_devoilee', vraieReponse); // Dévoile la réponse

    // Reset des votes pour vider l'écran
    salon.votesSkip = [];
    io.to(codeSalon).emit('maj_votes_skip', { votes: 0, total: salon.ordreJoueurs.length });

    if (salon.timeoutTransition) clearTimeout(salon.timeoutTransition);

    salon.timeoutTransition = setTimeout(() => {
        if (salons[codeSalon]) lancerProchainTour(io, codeSalon, salon);
    }, delai);
}

function demarrerChrono(io, codeSalon, salon) {
    clearInterval(salon.intervalle);
    salon.intervalle = setInterval(() => {
        if (salon.enPause || salon.transitionEnCours) return;

        if (salon.temps[salon.joueurActif] > 0) {
            salon.temps[salon.joueurActif] -= 1;
            io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
        }

        if (salon.temps[salon.joueurActif] <= 0) {
            clearInterval(salon.intervalle);

            if (salon.mode === 'buzzer') {
                // Pas de points en dessous de 0
                salon.scores[salon.joueurActif] = Math.max(0, salon.scores[salon.joueurActif] - 5);
                const exJoueur = salon.joueurActif;
                salon.joueurActif = 'bloque';
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });

                declencherTransition(io, codeSalon, salon, `⏱️ Trop lent ! -5 pts pour ${salon.pseudos[exJoueur]}.`);
            } else {
                const joueurElimine = salon.joueurActif;
                if (!joueurElimine.startsWith('BOT_')) io.to(joueurElimine).emit('afficher_ecran_defaite');

                salon.ordreJoueurs = salon.ordreJoueurs.filter(id => id !== joueurElimine);
                salon.indexTour -= 1;
                if (salon.indexTour < -1) salon.indexTour = -1;

                if (salon.ordreJoueurs.length === 1 && salon.mode !== 'presentateur' && salon.joueurs.length > 1) {
                    io.to(codeSalon).emit('fin_partie', `🏆 Victoire de ${salon.pseudos[salon.ordreJoueurs[0]]} !`);
                } else if (salon.ordreJoueurs.length === 0) {
                    io.to(codeSalon).emit('fin_partie', `🏁 La partie est terminée !`);
                } else {
                    declencherTransition(io, codeSalon, salon, `👋 ${salon.pseudos[joueurElimine]} est éliminé !`);
                }
            }
        }
    }, 1000);
}

function lancerProchainTour(io, codeSalon, salon) {
    salon.transitionEnCours = false; // On débloque le jeu
    clearInterval(salon.intervalle);
    clearTimeout(salon.botTimeout);

    salon.votesSkip = [];
    io.to(codeSalon).emit('maj_votes_skip', { votes: 0, total: salon.ordreJoueurs.length });

    let pseudoSuivant = null;

    if (salon.mode === 'classique' || salon.mode === 'presentateur') {
        salon.indexTour = (salon.indexTour + 1) % salon.ordreJoueurs.length;
        salon.joueurActif = salon.ordreJoueurs[salon.indexTour];

        if (salon.ordreJoueurs.length > 1) {
            const indexSuivant = (salon.indexTour + 1) % salon.ordreJoueurs.length;
            pseudoSuivant = salon.pseudos[salon.ordreJoueurs[indexSuivant]];
        }
    } else if (salon.mode === 'buzzer') {
        salon.joueurActif = null;
    }

    const questionTiree = tirerQuestion(salon);
    salon.reponsesAttendues = questionTiree.reponses;

    io.to(codeSalon).emit('nouvelle_question', {
        question: questionTiree.question,
        reponses: questionTiree.reponses,
        theme: questionTiree.theme,
        pseudoActif: salon.joueurActif ? salon.pseudos[salon.joueurActif] : null,
        pseudoSuivant: pseudoSuivant,
        mode: salon.mode,
        options: salon.options
    });

    io.to(codeSalon).emit('changement_tour', { idJoueurActif: salon.joueurActif });

    if (salon.joueurActif !== null && salon.mode !== 'buzzer') {
        demarrerChrono(io, codeSalon, salon);
        if (salon.joueurActif.startsWith('BOT_') && !salon.enPause) {
            salon.botTimeout = setTimeout(() => {
                if (!salon.enPause && salon.joueurActif.startsWith('BOT_')) {
                    declencherTransition(io, codeSalon, salon, `🤖 ${salon.pseudos[salon.joueurActif]} passe son tour...`);
                }
            }, 4000);
        }
    }
}

function gererDepartJoueur(io, id, codeSalon, estKick = false) {
    const salon = salons[codeSalon];
    if (!salon) return;
    const pseudo = salon.pseudos[id];
    if (!pseudo) return;

    if (estKick) io.to(id).emit('tu_es_kick');

    io.to(codeSalon).emit('message_serveur', `🚪 ${pseudo} a quitté le jeu.`);

    delete salon.temps[id];
    delete salon.pseudos[id];
    delete salon.scores[id];
    salon.votesSkip = salon.votesSkip.filter(j => j !== id);
    salon.joueurs = salon.joueurs.filter(j => j !== id);
    salon.ordreJoueurs = salon.ordreJoueurs.filter(j => j !== id);

    io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
    io.to(codeSalon).emit('maj_lobby', Object.values(salon.pseudos));

    if (salon.joueurs.length === 0 && salon.createur !== id) {
        delete salons[codeSalon];
        diffuserSalonsPublics();
        return;
    }

    if (salon.partieCommencee && salon.joueurActif === id && !salon.transitionEnCours) {
        salon.indexTour -= 1;
        if (salon.indexTour < -1) salon.indexTour = -1;
        declencherTransition(io, codeSalon, salon, `⚠️ ${pseudo} a quitté. Suivant...`, 3000);
    }
}

io.on('connection', (socket) => {
    socket.emit('maj_salons_publics', diffuserSalonsPublics());

    socket.on('rejoindre_salon', (data) => {
        if (!data) return;
        const { codeSalon, pseudo, tempsChoisi, modeChoisi, optionsBonus, estPublic, isBotTest } = data;

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
                intervalle: null, botTimeout: null, joueurActif: null, enPause: false, transitionEnCours: false,
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

        if (isBotTest && salon.joueurs.length === 1) {
            const bots = ['BOT_1', 'BOT_2', 'BOT_3'];
            const nomsBots = ['🤖 Alpha', '🤖 Beta', '🤖 Gamma'];
            bots.forEach((idBot, index) => {
                salon.joueurs.push(idBot);
                salon.pseudos[idBot] = nomsBots[index];
                salon.temps[idBot] = salon.tempsInitial;
                salon.scores[idBot] = 0;
            });
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
        salon.partieCommencee = true;
        salon.ordreJoueurs = [...salon.joueurs].sort(() => Math.random() - 0.5);
        salon.indexTour = -1;
        io.to(codeSalon).emit('partie_lancee');
        lancerProchainTour(io, codeSalon, salon);
        diffuserSalonsPublics();
    });

    socket.on('quitter_salon', (codeSalon) => {
        socket.leave(codeSalon);
        gererDepartJoueur(io, socket.id, codeSalon, false);
    });

    socket.on('kick_joueur', (data) => {
        const { codeSalon, targetId } = data;
        const salon = salons[codeSalon];
        if (salon && socket.id === salon.createur) gererDepartJoueur(io, targetId, codeSalon, true);
    });

    socket.on('toggle_pause', (codeSalon) => {
        const salon = salons[codeSalon];
        if (salon && socket.id === salon.createur && salon.partieCommencee && !salon.transitionEnCours) {
            salon.enPause = !salon.enPause;
            io.to(codeSalon).emit('etat_pause', salon.enPause);
        }
    });

    socket.on('clic_buzzer', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || salon.mode !== 'buzzer' || salon.joueurActif !== null || salon.enPause || salon.transitionEnCours) return;
        if (!salon.ordreJoueurs.includes(socket.id) && salon.temps[socket.id] <= 0) return;

        salon.joueurActif = socket.id;
        io.to(codeSalon).emit('message_serveur', `🚨 ${salon.pseudos[socket.id]} a buzzé ! (5s)`);
        io.to(codeSalon).emit('changement_tour', { idJoueurActif: salon.joueurActif });

        let tempsRestant = 5;
        io.to(codeSalon).emit('tic_tac_buzzer', tempsRestant);

        clearInterval(salon.intervalle);
        salon.intervalle = setInterval(() => {
            if (salon.enPause || salon.transitionEnCours) return;
            tempsRestant -= 1;
            io.to(codeSalon).emit('tic_tac_buzzer', tempsRestant);

            if (tempsRestant <= 0) {
                clearInterval(salon.intervalle);
                salon.scores[salon.joueurActif] = Math.max(0, salon.scores[salon.joueurActif] - 5);
                const exJoueur = salon.joueurActif;
                salon.joueurActif = 'bloque';
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });
                declencherTransition(io, codeSalon, salon, `⏱️ Trop lent ! -5 pts pour ${salon.pseudos[exJoueur]}.`);
            }
        }, 1000);
    });

    socket.on('proposer_reponse', (data) => {
        const { codeSalon, reponseJoueur } = data;
        const salon = salons[codeSalon];
        if (!salon || socket.id !== salon.joueurActif || salon.enPause || salon.transitionEnCours) return;

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
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });

                // LA VICTOIRE À 50 POINTS
                if (salon.scores[socket.id] >= 50) {
                    io.to(codeSalon).emit('fin_partie', `🏆 ${salon.pseudos[socket.id]} a atteint 50 points et GAGNE LA PARTIE !`);
                    return;
                }
                declencherTransition(io, codeSalon, salon, `✅ Bonne réponse de ${salon.pseudos[socket.id]} ! (+10 pts)`);
            } else {
                io.to(codeSalon).emit('bonne_reponse', `✅ Bonne réponse de ${salon.pseudos[socket.id]} !`);
                declencherTransition(io, codeSalon, salon, `La bonne réponse était bien : ${salon.reponsesAttendues[0]}`);
            }
        } else {
            if (salon.mode === 'buzzer') {
                clearInterval(salon.intervalle);
                salon.scores[socket.id] = Math.max(0, salon.scores[socket.id] - 5);
                const exJoueur = socket.id;
                salon.joueurActif = 'bloque';
                io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos, scores: salon.scores });

                declencherTransition(io, codeSalon, salon, `❌ Faux ! -5 pts pour ${salon.pseudos[exJoueur]}.`);
            } else {
                socket.emit('mauvaise_reponse', "❌ Faux, réessaie vite !");
            }
        }
    });

    socket.on('jugement_presentateur', (data) => {
        const { codeSalon, estCorrect } = data;
        const salon = salons[codeSalon];
        if (!salon || salon.mode !== 'presentateur' || socket.id !== salon.createur || salon.enPause || salon.transitionEnCours) return;

        if (estCorrect) {
            declencherTransition(io, codeSalon, salon, `✅ Le présentateur a validé !`);
        } else {
            declencherTransition(io, codeSalon, salon, `❌ Refusé ! La réponse était : ${salon.reponsesAttendues[0]}`);
        }
    });

    socket.on('skip_question', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || salon.enPause || salon.transitionEnCours) return;

        if (salon.mode === 'buzzer') {
            if (salon.joueurActif !== null) return;

            if (!salon.votesSkip.includes(socket.id)) {
                salon.votesSkip.push(socket.id);
                io.to(codeSalon).emit('maj_votes_skip', { votes: salon.votesSkip.length, total: salon.ordreJoueurs.length });

                // VÉRIFICATION MAJORITÉ BLINDÉE
                if (salon.votesSkip.length > salon.ordreJoueurs.length / 2) {
                    declencherTransition(io, codeSalon, salon, `⏭️ Majorité atteinte ! La réponse était : ${salon.reponsesAttendues[0]}`);
                }
            }
        } else {
            if (socket.id !== salon.joueurActif && socket.id !== salon.createur) return;
            declencherTransition(io, codeSalon, salon, `⏭️ Question passée. La réponse était : ${salon.reponsesAttendues[0]}`);
        }
    });

    socket.on('en_train_de_taper', (data) => {
        if (!data) return;
        socket.to(data.codeSalon).emit('frappe_adversaire', { pseudo: socket.pseudo, texte: data.texte });
    });

    socket.on('disconnect', () => {
        if (socket.codeSalon) gererDepartJoueur(io, socket.id, socket.codeSalon, false);
    });
});

server.listen(3000, () => { console.log('Serveur lancé !'); });