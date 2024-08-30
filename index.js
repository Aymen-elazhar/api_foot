const Openai = require('openai');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());

const openai = new Openai();
const footballApiToken = '7663da8bd5e85cb6a86f6772e78752cc';

let conversationState = {};

function convertDateFormat(dateStr) {
    const [day, month, year] = dateStr.split('/');
    return `${year}-${month}-${day}`;
}

// Fonction pour interroger ChatGPT
async function askChatGPT(text, res) {
    console.log("Entrée dans askChatGPT avec le texte:", text);

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Tu es un agent chargé d'extraire des informations spécifiques d'un message utilisateur. Extrais UNIQUEMENT le nom de la ligue et la date. Formate la réponse comme un JSON. Si une information est manquante, ne mets pas l'objet correspondant dans le JSON. Si un élément est manquant, ajoute-le à l'objet 'missing' dans le JSON."
                },
                {
                    role: "user",
                    content: `Extrait la ligue et la date de ce texte : ${text}`
                }
            ],
            temperature: 0.7
        });

        let responseText = completion.choices[0].message.content.trim();
        console.log("Réponse brute de ChatGPT:", responseText);

        if (responseText.startsWith('```json')) {
            responseText = responseText.replace('```json', '').trim();
        }
        if (responseText.endsWith('```')) {
            responseText = responseText.replace('```', '').trim();
        }

        const jsonResponse = JSON.parse(responseText);
        console.log("JSON parsé de ChatGPT:", jsonResponse);

        const leagueName = jsonResponse.ligue ? jsonResponse.ligue.trim() : null;
        const date = jsonResponse.date ? convertDateFormat(jsonResponse.date.trim()) : null;

        // Si info ok
        if (leagueName && date) {
            console.log("Ligue et date trouvées:", leagueName, date);
            // Appeler l'API football-data pour obtenir les matchs
            const matchResults = await getMatchesForWeek(leagueName, date);
            console.log("Résultats des matchs:", matchResults);
            return res.json({ matches: matchResults });
        }

        // Si info non trouvée
        if (jsonResponse.missing) {
            conversationState = { ...conversationState, ...jsonResponse };
            let missingQuestions = [];

            if (jsonResponse.missing.ligue) {
                missingQuestions.push("De quelle ligue voulez-vous connaître les matchs ?");
            }

            if (jsonResponse.missing.date) {
                missingQuestions.push("Pour quelle semaine voulez-vous connaître les matchs ? (Indiquez la date de début de semaine)");
            }

            console.log("Informations manquantes:", missingQuestions);
            return res.json({
                message: missingQuestions.join(' et '),
                conversationState
            });
        }
    } catch (error) {
        console.error('Erreur lors de la communication avec l’API OpenAI:', error);
        return res.status(500).json({ error: 'Erreur lors de l’extraction des intentions.' });
    }
}

// Fonction pour interroger l'API football-data.org
async function getMatchesForWeek(leagueName, startDate) {
    console.log("getMatchesForWeek appelé avec:", leagueName, startDate);
    try {
        const leagueIdMapping = {
            "Ligue 1": 61,
            "La Liga": 140,
            "Serie A": 135,
            "Bundesliga": 78
        };

        const leagueId = leagueIdMapping[leagueName];
        if (!leagueId) {
            console.log("Ligue non trouvée dans le mapping:", leagueName);
            return [];
        }

        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 7);
        const formattedEndDate = endDate.toISOString().split('T')[0];

        console.log("Date de fin calculée:", formattedEndDate);

        const response = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
            headers: {
                'x-apisports-key': footballApiToken
            },
            params: {
                league: leagueId,
                season: new Date(startDate).getFullYear(),
                from: startDate,
                to: formattedEndDate
            }
        });

        console.log("Réponse API football-data:", response.data);

        if (response.data && response.data.response) {
            return response.data.response.map(match => ({
                date: match.fixture.date.split('T')[0],
                match: `${match.teams.home.name} vs ${match.teams.away.name}`,
                homeTeam: match.teams.home.name,
                awayTeam: match.teams.away.name,
                ligue: leagueName
            }));
        } else {
            console.error("Données de réponse de l'API mal formatées ou vides");
            return [];
        }
    } catch (error) {
        console.error('Erreur lors de la récupération des matchs:', error);
        return [];
    }
}

// Route pour poser des questions
app.post('/ask', async (req, res) => {
    const text = req.body.question;
    console.log("Nouvelle question reçue:", text);

    // Si l'utilisateur répond
    if (conversationState && Object.keys(conversationState).length > 0) {
        if (conversationState.missing && conversationState.missing.ligue && !conversationState.ligue) {
            conversationState.ligue = text.trim();
        } else if (conversationState.missing && conversationState.missing.date && !conversationState.date) {
            conversationState.date = text.trim();
        }

        // Si toutes les infos sont ok
        if (conversationState.ligue && conversationState.date) {
            console.log("Appel de getMatchesForWeek avec les informations complètes");
            const matchResults = await getMatchesForWeek(conversationState.ligue, conversationState.date);
            conversationState = {};
            return res.json({ matches: matchResults });
        } else {
            console.log("Informations manquantes pour compléter la requête");
            return res.json({
                message: "Merci, maintenant veuillez fournir la ligue ou la date manquante.",
                conversationState
            });
        }
    }

    // Si aucune info ne manque
    console.log("Appel initial à ChatGPT");
    await askChatGPT(text, res);
});

app.get('/matches', async (req, res) => {
    const leagueName = req.query.league;
    const startDate = req.query.date;
    console.log(`Demande de tableau pour la ligue ${leagueName} et la date ${startDate}`);
    
    const matchResults = await getMatchesForWeek(leagueName, startDate);

    console.log("Résultats des matchs JSON:", matchResults);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    let html = '<!DOCTYPE html><html><head><title>Matchs</title></head><body>';
    html += '<h1>Tableau des Matchs</h1>';
    html += '<table border="1">';
    html += '<tr><th>Date</th><th>Match</th><th>Équipe à domicile</th><th>Équipe à l’extérieur</th><th>Ligue</th></tr>';

    matchResults.forEach(match => {
        html += `<tr>
                    <td>${match.date || 'N/A'}</td>
                    <td>${match.match || 'N/A'}</td>
                    <td>${match.homeTeam || 'N/A'}</td>
                    <td>${match.awayTeam || 'N/A'}</td>
                    <td>${match.ligue || 'N/A'}</td>
                 </tr>`;
    });

    html += '</table>';
    html += '</body></html>';

    res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
