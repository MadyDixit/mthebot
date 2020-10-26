// Copyright (c) 2020 Mitchell Adair
// 
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

const express = require('express');
const https = require('https');
const url = require('url');
const users = require('./publicAPIs/users');
const commands = require('./privateAPIs/commands');
const timers = require('./privateAPIs/timers');
const events = require('./privateAPIs/events');
const chats = require('./privateAPIs/chats');
const init = require('./privateAPIs/init');
const contact = require('./publicAPIs/contact');
const auth = require('./privateAPIs/auth');

const {channelExistsInDB} = require('./utils');

const timedLog = message => {
    console.log(`${new Date(Date.now()).toUTCString()} ${message}`);
}

module.exports = function(db, actions) {
    const server = express();
    const port = process.env.PORT || 8080;

    let sessionPool = {};

    // Authentication middleware for Express
    const requireAuth = (req, res, next) => {
        //let all requests through in dev mode
        if (process.env.NODE_ENV === 'development') {
            next();
            return;
        }

        const channel = req.params.channel;

        // manage the session pool
        // if the user has an active session (timed out in 5 minutes), let the request through
        // if not, make a request to Twitch to ensure the user's auth token matches for the channel
        if (sessionPool[channel]) {
            clearTimeout(sessionPool[channel].timeout);
            sessionPool[channel] = {
                timeout: setTimeout(_ => {
                    clearTimeout(sessionPool[channel].timeout);
                    delete sessionPool[channel];
                }, 300000),
            }
            next();
            return;
        } else {
            const headers = {
                'Authorization': req.headers.authorization,
                'Client-ID': process.env.CLIENT_ID,
            }
            https.get('https://id.twitch.tv/oauth2/validate', {headers: headers}, r => {
                let body = [];
                r.on('error', err => {
                    res.writeHead(err.status);
                    res.end(`ERROR: ${err}`);
                }).on('data', chunk => {
                    body.push(chunk);
                }).on('end', _ => {
                    body = JSON.parse(Buffer.concat(body).toString());
                    if (body.expires_in < 3600) {
                        res.writeHead(401);
                        res.end('OAuth Token Expired');
                    } else if (body.user_id !== channel) {
                        res.writeHead(401);
                        res.end('Unauthorized request to private API');
                    } else {
                        sessionPool[channel] = {
                            timeout: setTimeout(_ => {
                                clearTimeout(sessionPool[channel].timeout);
                                delete sessionPool[channel];
                            }, 300000),
                        }
                        next();
                        return;
                    }
                });
            });
        }
    }

    // use express.json for body parsing
    server.use(express.json());

    // check if channel exists for all routes with channel param
    server.param('channel', (req, res, next, id) => {
        channelExistsInDB(db, id).then(_ => {
            return next();
        }).catch(err => {
            res.writeHead(404);
            return res.end(`Channel ${id} not found`);
        });
    })

    // COMMANDS API Routes
    server.route('/commands/:channel/:alias?', requireAuth)
        .get((req, res) => {commands.get(db, req, res)})
        .post((req, res) => {commands.post(db, actions, req, res)})
        .put((req, res) => {commands.put(db, actions, req, res)})
        .delete((req, res) => {commands.remove(db, actions, req, res)});

    // request handler
    const apiRequestHandler = (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        // prevent CORS issue
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
    }

    server.listen(port, _ => {timedLog(`API Server listening on port ${port}`)});
}