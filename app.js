require('dotenv').config();
const tmi = require('tmi.js');
const mysql = require('mysql');
const axios = require('axios');

// ===================== DATA =====================

let activeChannels = [];

// ===================== HELPER FUNCTIONS =====================

Array.prototype.chunk = function(maxChunkSize) {
    let copy = [...this];
    let chunks = [];
    while (copy.length) {
        const size = copy.length > maxChunkSize ? maxChunkSize : copy.length;
        chunks.push(copy.splice(0, size));
    }
    return chunks;
}

// ===================== EVENT HANDLERS =====================

const onConnected = (address, port) => {
    console.log(`** MtheBot_ connected to ${address}:${port}`);
}

const onChat = (channel, userstate, message, self) => {
    if (self) return;

    const full = message.trim();

    if (full.startsWith('!')) {
        const args = full.split(' ');
        const command = args.shift().substring(1);
    }
}

// ===================== BOT LIFECYCLE =====================

// audit list of active channels to save on memory usage
const auditChannels = async () => {
    console.log('** auditing active channels...');
    db.query("SELECT name from channels", (err, results, fields) => {
        const chunks = results.chunk(100);
        let promises = chunks.map(chunk => {
            const headers = {
                'Client-ID': process.env.CLIENT_ID,
            }
            let params = new URLSearchParams();
            chunk.forEach(data => {
                params.append('user_login', data.name);
            });
            const config = {
                headers: headers,
                params: params,
            }
            return axios.get('https://api.twitch.tv/helix/streams', config);
        });
        Promise.all(promises).then(responses => {
            let newActiveChannels = [];
            responses.forEach(res => {
                newActiveChannels.push(...res.data.data.map(data => {
                    return data.user_name.toLowerCase();
                }));
            });
            let channelsNoLongerActive = activeChannels.filter(channel => {
                return !newActiveChannels.includes(channel);
            });
            channelsNoLongerActive.forEach(channel => {
                client.part(channel).then(data => {
                    console.log(`** Left channel: ${data}`);
                }).catch(err => {
                    console.log(`** ERROR LEAVING CHANNEL: ${err}`);
                });
            });
            let newlyActiveChannels = newActiveChannels.filter(channel => {
                return !activeChannels.includes(channel);
            });
            newlyActiveChannels.forEach(channel => {
                client.join(channel).then(data => {
                    console.log(`** Joined channel: ${data}`);
                }).catch(err => {
                    console.log(`** ERROR JOINING CHANNEL: ${err}`);
                });
            });
            activeChannels = ['mtheb_', ...newActiveChannels];
            console.log('** active channel audit completed');
        });
    });
}
setInterval(auditChannels, 300000);

// ===================== INIT CHAT BOT/DB CONNECTION =====================

const opts = {
    identity: {
        username: 'MtheBot_',
        password: process.env.OAUTH_TOKEN,
    },
    channels: [
        'MtheB_'
    ]
};

const client = new tmi.client(opts);

// EVENT HANDLER REGISTRATION
client.on('connected', onConnected);
client.on('chat', onChat);

client.connect();

const db = mysql.createConnection({
    host: process.env.RDS_HOSTNAME,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    port: process.env.RDS_PORT,
    database: process.env.RDS_DB_NAME
});

db.connect(err => {
    if (err) {
        console.error(`** DB Connection failed: ${err.stack}`);
        return;
    }

    console.log('** Connected to DB');
});

auditChannels();