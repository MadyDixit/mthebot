// Copyright (c) 2020 Mitchell Adair
// 
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

require('dotenv').config();
const tmi = require('tmi.js');
const mysql = require('mysql');
const APIServer = require('./API Server/apiserver');
const twitchAPI = require('./External Data APIs/twitch');
const PubSub = require('./PubSub/pubsub');

// ===================== HELPER FUNCTIONS =====================

const timedLog = message => {
    console.log(`${new Date(Date.now()).toUTCString()} ${message}`);
}

// extend Array to include a 'chunk' function
// use function rather than arrow func to access 'this'
// makes shallow copy of current array, then splits the array into chunks of the given max chunk size and returns it
Array.prototype.chunk = function(maxChunkSize) {
    let copy = [...this];
    let chunks = [];
    while (copy.length) {
        const size = copy.length > maxChunkSize ? maxChunkSize : copy.length;
        chunks.push(copy.splice(0, size));
    }
    return chunks;
}

const getLengthDataFromMillis = ms => {
    const date = new Date(ms);
    return {
        years: date.getUTCFullYear() - 1970,
        months: date.getUTCMonth(),
        days: date.getUTCDate() - 1,
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
    }
}

// ===================== DATA =====================

let channels = {};

const USER_TYPES = {
    user: 0,
    vip: 1,
    subscriber: 2,
    moderator: 3,
    global_mod: 3,
    broadcaster: 3,
}

const DATA_TAGS = [
    {
        tag: '{{followage}}',
        dataFetch: (channel, userstate) => {
            return new Promise((resolve, reject) => {
                twitchAPI.getFollowData(userstate['user-id'], channels[channel].id).then(data => {
                    if (data) {
                        const length = getLengthDataFromMillis(Date.now() - Date.parse(data.followed_at));
                        const val = `
                            ${length.years > 0 ? `${length.years} year${length.years > 1 ? 's' : ''}` : ''}
                            ${length.months > 0 ? `${length.months} month${length.months > 1 ? 's' : ''}` : ''}
                            ${length.days > 0 ? `${length.days} day${length.days > 1 ? 's' : ''}` : ''}
                        `;
                        resolve({tag: '{{followage}}', value: val});
                    } else {
                        resolve({tag: '{{followage}}', value: `${user} does not follow ${channel}`});
                    }
                }).catch(err => {
                    reject({tag: '{{followage}}', reason: 'error fetching followage data'});
                });
            });
        },
    },
    {
        tag: '{{followcount}}',
        dataFetch: (channel, userstate) => {
            return new Promise((resolve, reject) => {
                twitchAPI.getFollowCount(channels[channel].id).then(data => {
                    resolve({tag: '{{followcount}}', value: data});
                }).catch(err => {
                    reject({tag: '{{followcount}}', reason: 'error fetching followcount data'});
                });
            });
        }
    },
    {
        tag: '{{subcount}}',
        dataFetch: (channel, userstate) => {
            return new Promise((resolve, reject) => {
                twitchAPI.getSubCount(channels[channel].id).then(data => {
                    resolve({tag: '{{subcount}}', value: data});
                }).catch(err => {
                    reject({tag: '{{subcount}}', reason: 'error fetching subcount data'});
                });
            });
        }
    },
    {
        tag: '{{uptime}}',
        dataFetch: (channel, userstate) => {
            return new Promise((resolve, reject) => {
                twitchAPI.getStreamData(channel).then(data => {
                    if (data) {
                        const length = getLengthDataFromMillis(Date.now() - Date.parse(data.started_at));
                            const val = `
                                ${length.days > 0 ? `${length.days} day${length.days > 1 ? 's' : ''}` : ''}
                                ${length.hours > 0 ? `${length.hours} hour${length.hours > 1 ? 's' : ''}` : ''}
                                ${length.minutes > 0 ? `${length.minutes} minute${length.minutes > 1 ? 's' : ''}` : ''}
                                ${length.seconds > 0 ? `${length.seconds} second${length.seconds > 1 ? 's' : ''}` : ''}
                            `;
                        resolve({tag: '{{uptime}}', value: val});
                    } else {
                        resolve({tag: '{{uptime}}', value: `${channel} is not live`});
                    }
                }).catch(err => {
                    reject({tag: '{{uptime}}', reason: 'error fetching uptime data'});
                });
            })
        },
    },
    {
        tag: '{{game}}',
        dataFetch: (channel, userstate) => {
            return new Promise((resolve, reject) => {
                twitchAPI.getStreamData(channel).then(data => {
                    if (data) {
                        twitchAPI.getGameName(data.game_id).then(name => {
                            resolve({tag: '{{game}}', value: name});
                        }).catch(err => {
                            reject({tag: '{{game}}', reason: 'error fetching game data'});
                        });
                    } else {
                        resolve({tag: '{{game}}', value: `${channel} is not live`});
                    }
                }).catch(err => {
                    reject({tag: '{{game}}', reason: 'error fetching game data'});
                });
            })
        },
    },
    
]

// ===================== DATA FUNCTIONS =====================

// remove a channel from the active channels object
const deleteChannel = channel => {
    // clear intervals for timed messages
    if (channels[channel]) {
        channels[channel].timers.forEach(timer => {
            clearInterval(timer.interval);
        });
        delete channels[channel];
        timedLog(`** BOT: Removed channel ${channel} from active channels`);
    }
}

// get channel data from DB
const fetchChannelData = channelKey => {
    return new Promise((resolve, reject) => {
        twitchAPI.getUser(channelKey).then(data => {
            db.query(`SELECT name FROM channels WHERE id=${data.id}`, (err, results) => {
                if (err) {
                    return reject(err);
                } else {
                    if (results[0].name !== channelKey) {
                        db.query(`UPDATE channels set name='${channelKey}' where id=${data.id}`, err => {
                            if (err) {
                                timedLog(`** BOT: Error updating name for id ${data.id}: ${err}`);
                            } else {
                                timedLog(`** BOT: Updated name for id ${data.id} in DB to ${channelKey}`);
                            }
                        });
                    }

                    let commands = [];
                    let events = {};
                    let timers = [];
                    let redemptions = [];
                    let promises = []

                    promises.push(new Promise((resolve, reject) => {
                        db.query(`SELECT * from commands where channel_id=${data.id}`, (err, results) => {
                            if (err) {
                                reject(err);
                            }
                            commands = results.map(c => {
                                return {
                                    alias: c.alias,
                                    message: c.message,
                                    cooldown: c.cooldown,
                                    user_level: c.user_level,
                                }
                            });
                            resolve();
                        });
                    }));
                    promises.push(new Promise((resolve, reject) => {
                        db.query(`SELECT * from events where channel_id=${data.id}`, (err, results) => {
                            if (err) {
                                reject(err);
                            }
                            results.forEach(e => {
                                events[e.name] = {
                                    message: e.message,
                                    enabled: e.enabled
                                }
                            });
                            resolve();
                        });
                    }));
                    promises.push(new Promise((resolve, reject) => {
                        db.query(`SELECT * from timers where channel_id=${data.id}`, (err, results) => {
                            if (err) {
                                reject(err);
                            }
                            timers = results.map(t => {
                                return {
                                    name: t.name,
                                    message: t.message,
                                    enabled: t.enabled,
                                    interval: t.interval,
                                    message_threshold: t.message_threshold
                                }
                            });
                            resolve();
                        });
                    }));

                    Promise.all(promises).then(_ => {
                        channels[channelKey] = {
                            commands: commands,
                            events: events,
                            timeout: setTimeout(_ => {deleteChannel(channelKey)}, 300000),
                            timers: timers.map((timer, i) => {
                                if (timer.enabled) {
                                    return {
                                        interval: setInterval(_ => {
                                            if (channels[channelKey].timers[i].messageCount >= timer.message_threshold) {
                                                channels[channelKey].timers[i].messageCount = 0;
                                                client.say(`#${channelKey}`, timer.message);
                                            }
                                        }, timer.interval*1000),
                                        messageCount: 0,
                                    }
                                }
                            }),
                            id: data.id,
                        }
                        timedLog(`** BOT: Fetched data for channel ${channelKey}`);
                        resolve();
                    });
                }
            });
        }).catch(err => {
            timedLog(`** BOT: Error getting user data for channel ${channelKey}`)
            reject(err);
        });
    });
}

// process the given channel
// either restart the timeout func or add the channel to active channels
const processChannel = channelKey => {
    return new Promise((resolve, reject) => {
        if (channels[channelKey] !== undefined) {
            clearTimeout(channels[channelKey].timeout);
            channels[channelKey].timeout = setTimeout(_ => {deleteChannel(channelKey)}, 300000);
            resolve();
        } else {
            fetchChannelData(channelKey).then(_ => {
                timedLog(`** BOT: Added channel ${channelKey} to active channels`);
                resolve();
            }).catch(err => {
                reject(err);
            })
        }
    });
}

const getUserLevel = (userstate) => {
    return userstate['badges-raw'] ? userstate['badges-raw'].split(',').map(badge => {
        return badge.split('/')[0];
    }).reduce((total, badge) => {
        if (USER_TYPES[badge] && USER_TYPES[badge] > total) {
            return USER_TYPES[badge];
        }
        return total;
    }, USER_TYPES.user) : 0;
}

// ===================== EVENT HANDLERS =====================

const onConnected = (address, port) => {
    timedLog(`** BOT: Connected to ${address}:${port}`);
    timedLog(`** BOT: Joining all serviced channels...`);
    db.query("SELECT id,enabled from channels", (err, results, fields) => {
        if (err) {
            timedLog(`** BOT: Error querying DB for channels: ${err}`);
            return;
        }
        let toJoin = results ? results.filter(res => res.enabled).map(res => {
            return res.id;
        }) : [];
        twitchAPI.getBatchUsersByID(toJoin).then(data => {
            let batches = data.chunk(50);
            let promises = [];
            batches.forEach((batch, i) => {
                promises.push(new Promise((resolve, reject) => {
                    setTimeout(_ => {
                        let joinPromises = [];
                        batch.forEach(user => {
                            joinPromises.push(client.join(user.name));
                        });
                        Promise.all(joinPromises).then(_ => {
                            resolve();
                        }).catch(e => {
                            reject(e);
                        })
                    }, i * 15000);
                }));
            });
            Promise.all(promises).then(_ => {
                timedLog(`** BOT: All channels joined`);
            }).catch(e => {
                timedLog(`** BOT: Error joining channels: ${e}`);
            });
        });
    });
}

const onChat = (channel, userstate, message, self) => {
    if (self) return;

    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        channels[channelKey].timers.forEach(timer => {
            timer.messageCount++
        });
        const full = message.trim();

        if (full.startsWith('!')) {
            const userLevel = getUserLevel(userstate);
            const args = full.split(' ');
            const alias = args.shift().substring(1);
            const command = channels[channelKey].commands.find(cmd => {
                return cmd.alias === alias;
            });
            if (command && !command.isOnCooldown && userLevel >= command.user_level) {
                command.isOnCooldown = true;
                setTimeout(_ => {command.isOnCooldown = false}, command.cooldown * 1000);
                let message = command.message
                    .replace(new RegExp('{{sender}}', 'g'), userstate['display-name'])
                    .replace(new RegExp('{{channel}}', 'g'), channelKey)
                    .replace(new RegExp('{{commands}}', 'g'), channels[channelKey].commands.filter(c => c.user_level === 0).map(c => `!${c.alias}`).join(', '));
                let messagePromises = [];
                DATA_TAGS.forEach(dt => {
                    if (message.includes(dt.tag)) {
                        messagePromises.push(dt.dataFetch(channelKey, userstate));
                    }
                });
                Promise.allSettled(messagePromises).then(results => {
                    results.forEach(r => {
                        if (r.status === 'fulfilled') {
                            message = message.replace(new RegExp(r.value.tag, 'g'), r.value.value);
                        } else {
                            message = message.replace(new RegExp(r.reason.tag, 'g'), r.reason.reason);
                        }
                    });
                    client.say(channel, message);
                });
            }
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onHost = (channel, username, viewers, autohost) => {
    if (!autohost) {
        const channelKey = channel.substring(1);
        processChannel(channelKey).then(_ => {
            const data = channels[channelKey].events.host;
            if (data.enabled) {
                let message = data.message
                    .replace(new RegExp('{{user}}', 'g'), username)
                    .replace(new RegExp('{{viewers}}', 'g'), viewers);
                client.say(channel, message);
            }
        }).catch(err => {
            timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
        });
    }
}

const onRaid = (channel, username, viewers) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.raid;
        if (data.enabled) {
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{viewers}}', 'g'), viewers);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onResub = (channel, username, monthStreak, message, userstate, methods) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.resub;
        if (data.enabled) {
            const months = ~~userstate["msg-param-cumulative-months"];
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{months}}', 'g'), months)
                .replace(new RegExp('{{streak}}', 'g'), monthStreak)
                .replace(new RegExp('{{type}}', 'g'), methods.planName);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onSubGift = (channel, username, monthStreak, recipient, methods, userstate) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.subgift;
        if (data.enabled) {
            const total = ~~userstate["msg-param-sender-count"];
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{total}}', 'g'), total)
                .replace(new RegExp('{{streak}}', 'g'), monthStreak)
                .replace(new RegExp('{{recipient}}', 'g'), recipient)
                .replace(new RegExp('{{type}}', 'g'), methods.planName);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onSubMysteryGift = (channel, username, numbOfSubs, methods, userstate) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.mysterygift;
        if (data.enabled) {
            const total = ~~userstate["msg-param-sender-count"];
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{total}}', 'g'), total)
                .replace(new RegExp('{{count}}', 'g'), numbOfSubs)
                .replace(new RegExp('{{type}}', 'g'), methods.planName);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onSub = (channel, username, methods, message, userstate) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.sub;
        if (data.enabled) {
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{type}}', 'g'), methods.planName);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onAnonGiftUpgrade = (channel, username, userstate) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.anongiftupgrade;
        if (data.enabled) {
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onGiftUpgrade = (channel, username, sender, userstate) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.giftupgrade;
        if (data.enabled) {
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{gifter}}', 'g'), sender);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

const onCheer = (channel, userstate, message) => {
    const channelKey = channel.substring(1);
    processChannel(channelKey).then(_ => {
        const data = channels[channelKey].events.cheer;
        if (data.enabled) {
            let message = data.message
                .replace(new RegExp('{{user}}', 'g'), username)
                .replace(new RegExp('{{amount}}', 'g'), userstate.bits);
            client.say(channel, message);
        }
    }).catch(err => {
        timedLog(`** BOT: ERROR ON CHANNEL ${channelKey}: ${err}`);
    });
}

// ===================== INIT CHAT BOT/DB/PUBSUB =====================

const opts = {
    identity: {
        username: process.env.BOT_USERNAME,
        password: process.env.OAUTH_TOKEN,
    },
    channels: [
        'MtheB_'
    ],
    connection: {
        reconnect: true,
        secure: true,
    }
};

const client = new tmi.client(opts);

// EVENT HANDLER REGISTRATION
client.on('connected', onConnected);
client.on('chat', onChat);
client.on('hosted', onHost);
client.on('raided', onRaid);
client.on('resub', onResub);
client.on('subgift', onSubGift);
client.on('submysterygift', onSubMysteryGift);
client.on('subscription', onSub);
client.on('paidgiftupgrade', onGiftUpgrade);
client.on('anonpaidgiftupgrade', onAnonGiftUpgrade);
client.on('cheer', onCheer);

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
        console.error(`** BOT: DB Connection failed: ${err.stack}`);
        return;
    }
    timedLog(`** BOT: Connected to DB`);
});

const ps = new PubSub();

// ===================== INIT API SERVER =====================

const actions = {
    refreshChannelData: channelID => {
        db.query("SELECT name from channels where id=?", [channelID], (err, results) => {
            if (err) {
                timedLog(`** BOT: ERROR refreshing channel ${channel}: ${err}`);
                return;
            }
            const channel = results[0].name;
            if (channels[channel] !== undefined) {
                timedLog(`** BOT: Refreshing data for channel ${channel}...`);
                deleteChannel(channel);
                fetchChannelData(channel).then(_ => {
                    timedLog(`** BOT: Refreshed channel ${channel}`);
                }).catch(err => {
                    timedLog(`** BOT: ERROR refreshing channel ${channel}: ${err}`);
                })
            }
        });
    },
    joinChannel: channel => {
        return twitchAPI.getBatchUsersByID([channel]).then(data => {
            return data[0] ? client.join(data[0].name) : true;
        });
    },
    leaveChannel: channel => {
        return twitchAPI.getBatchUsersByID([channel]).then(data => {
            return data[0] ? client.part(data[0].name) : true;
        });
    }
}

APIServer(db, actions);