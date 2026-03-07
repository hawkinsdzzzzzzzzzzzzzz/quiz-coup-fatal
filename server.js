const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stringSimilarity = require('string-similarity');

// On importe toutes les questions depuis le fichier JSON
const questionsList = require('./questions.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const salons = {};

// NOUVEAU : Fonction pour piocher une question SANS la répéter
function tirerQuestion(salon) {
    // Si le paquet est vide, on le recharge avec toutes les questions
    if (salon.questionsRestantes.length === 0) {
        salon.questionsRestantes = [...questionsList];
    }

    const randomIndex = Math.floor(Math.random() * salon.questionsRestantes.length);
    const questionTiree = salon.questionsRestantes[randomIndex];

    // On retire la question du paquet pour ne plus retomber dessus
    salon.questionsRestantes.splice(randomIndex, 1);

    return questionTiree;
}

function lancerProchainTour(io, codeSalon, salon) {
    clearInterval(salon.intervalle);
    io.to(codeSalon).emit('changement_tour', salon.joueurActif);

    // On utilise notre nouvelle fonction de pioche
    const questionTiree = tirerQuestion(salon);
    salon.reponsesAttendues = questionTiree.reponses;

    io.to(codeSalon).emit('nouvelle_question', {
        question: questionTiree.question,
        theme: questionTiree.theme,
        difficulte: questionTiree.difficulte,
        pseudoActif: salon.pseudos[salon.joueurActif]
    });

    salon.intervalle = setInterval(() => {
        if (salon.temps[salon.joueurActif] > 0) {
            salon.temps[salon.joueurActif] -= 1;
            io.to(codeSalon).emit('maj_temps', { temps: salon.temps, pseudos: salon.pseudos });
        }

        if (salon.temps[salon.joueurActif] <= 0) {
            clearInterval(salon.intervalle);
            io.to(codeSalon).emit('fin_partie', `Temps écoulé pour ${salon.pseudos[salon.joueurActif]} ! La partie est terminée.`);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('rejoindre_salon', (data) => {
        if (!data) return;
        const { codeSalon, pseudo, tempsChoisi } = data;

        socket.join(codeSalon);
        socket.pseudo = pseudo;
        socket.codeSalon = codeSalon;

        if (!salons[codeSalon]) {
            salons[codeSalon] = {
                joueurs: [], pseudos: {}, temps: {},
                tempsInitial: parseInt(tempsChoisi) || 60,
                intervalle: null, joueurActif: null,
                reponsesAttendues: [],
                partieCommencee: false, ordreJoueurs: [], indexTour: 0,
                createur: socket.id,
                questionsRestantes: [...questionsList] // NOUVEAU : On crée le paquet au lancement du salon
            };
        }

        if (!salons[codeSalon].joueurs.includes(socket.id)) {
            salons[codeSalon].joueurs.push(socket.id);
            salons[codeSalon].pseudos[socket.id] = pseudo;
            salons[codeSalon].temps[socket.id] = salons[codeSalon].tempsInitial;
        }

        socket.emit('info_role', { estChef: salons[codeSalon].createur === socket.id });
        io.to(codeSalon).emit('maj_joueurs', salons[codeSalon].joueurs.length);
        io.to(codeSalon).emit('maj_temps', { temps: salons[codeSalon].temps, pseudos: salons[codeSalon].pseudos });
    });

    socket.on('lancer_partie', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || salon.partieCommencee || socket.id !== salon.createur) return;
        if (salon.joueurs.length < 2) return;

        salon.partieCommencee = true;
        salon.ordreJoueurs = [...salon.joueurs].sort(() => Math.random() - 0.5);
        salon.indexTour = 0;
        salon.joueurActif = salon.ordreJoueurs[salon.indexTour];

        io.to(codeSalon).emit('partie_lancee');
        lancerProchainTour(io, codeSalon, salon);
    });

    socket.on('proposer_reponse', (data) => {
        if (!data || !data.reponseJoueur) return;

        const { codeSalon, reponseJoueur } = data;
        const salon = salons[codeSalon];
        if (!salon || socket.id !== salon.joueurActif) return;

        const bonnesReponses = salon.reponsesAttendues;
        if (!bonnesReponses || bonnesReponses.length === 0) return;

        let reponseValidee = false;

        for (let reponse of bonnesReponses) {
            const score = stringSimilarity.compareTwoStrings(reponseJoueur.toLowerCase(), reponse.toLowerCase());
            if (score > 0.8) {
                reponseValidee = true;
                break;
            }
        }

        if (reponseValidee) {
            salon.indexTour = (salon.indexTour + 1) % salon.ordreJoueurs.length;
            salon.joueurActif = salon.ordreJoueurs[salon.indexTour];

            io.to(codeSalon).emit('bonne_reponse', `✅ Bonne réponse de ${salon.pseudos[socket.id]} !`);
            lancerProchainTour(io, codeSalon, salon);
        } else {
            socket.emit('mauvaise_reponse', "❌ Faux, essaie encore !");
        }
    });

    socket.on('skip_question', (codeSalon) => {
        const salon = salons[codeSalon];
        if (!salon || socket.id !== salon.joueurActif) return;

        const questionTiree = tirerQuestion(salon);
        salon.reponsesAttendues = questionTiree.reponses;
        io.to(codeSalon).emit('nouvelle_question', {
            question: questionTiree.question,
            theme: questionTiree.theme,
            difficulte: questionTiree.difficulte,
            pseudoActif: salon.pseudos[salon.joueurActif]
        });
    });

    socket.on('en_train_de_taper', (data) => {
        if (!data) return;
        const { codeSalon, texte } = data;
        socket.to(codeSalon).emit('frappe_adversaire', { pseudo: socket.pseudo, texte: texte });
    });

    socket.on('disconnect', () => {
        const codeSalon = socket.codeSalon;
        if (codeSalon && salons[codeSalon]) {
            io.to(codeSalon).emit('message_serveur', `${socket.pseudo || 'Un joueur'} a quitté la partie.`);

            // NOUVEAU : Si le joueur quitte, on supprime son chrono pour les autres
            if (salons[codeSalon].temps[socket.id]) {
                delete salons[codeSalon].temps[socket.id];
                delete salons[codeSalon].pseudos[socket.id];
                salons[codeSalon].joueurs = salons[codeSalon].joueurs.filter(id => id !== socket.id);
                io.to(codeSalon).emit('maj_temps', { temps: salons[codeSalon].temps, pseudos: salons[codeSalon].pseudos });
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Le serveur tourne sur http://localhost:3000');
});