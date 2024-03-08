const fs = require('fs');
const url = require('url');
const hbs = require('hbs');
const path = require('path');
import https = require('https');
const axios = require('axios');
import crypto = require('crypto');
import winston = require('winston');
import express = require('express');
const bodyParser = require('body-parser');
import session = require('express-session');
const cookieParser = require('cookie-parser');
const schedule = require('node-schedule');
const storage = require('node-persist');
import { slackAuthUrl, codeToToken as slackCodeToToken, setStatus as setSlackStatus} from './slackController';
import { googleAuthUrl, codeToToken as googleCodeToToken, getUserId, getUserData, getCurrentPriorityEvent, getStatusTextFromEvent, getStatusEmojiFromEvent } from './googleController';
import { Credentials } from 'google-auth-library';
import { calendar_v3 } from 'googleapis';

const myWinstonFormat = winston.format.combine(
  winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss.SSS'}),
  winston.format.printf((info) => {
    return JSON.stringify({
      timestamp: info.timestamp,
      level: info.level,
      message: info.message
    });
  }),
  winston.format.errors({stack: true}),
);
const logger = winston.createLogger({
  level: 'info',
  format: myWinstonFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'app.log'
    })
  ]
})

const secrets = require('./secrets.json');

let privateKey = null;
let publicCert = null;
if (!secrets.development) {
  privateKey = fs.readFileSync('./private.key', 'utf8');
  publicCert = fs.readFileSync('./public.cert', 'utf8');
}

const httpsOptions = {
  key: privateKey,
  cert: publicCert
};
const httpsPort = 3000;
const baseUrl = secrets.baseUrl;

type Database = {
  users: User[];
};

type User = {
  gId: string;
  gAuth: Credentials;
  gName: string;
  sName: string | undefined;
  sAuth: string;
  useOOO: boolean;
  useDefault: boolean;
  useFocus: boolean;
  useLocation: boolean;
}

type Exception = {
  errorId: string;
  error: string;
}

// Augment express-session with a custom SessionData object
declare module "express-session" {
  interface SessionData {
    googletoken: Credentials;
    slacktoken: string | null;
    gid: string | null;
    wantsCancel: boolean;
  }
}

let database: Database = {
  users: []
};
// Get the persisted data and load it into the app
async function setupStorage() {
  await storage.init({
    dir: './storage'
  });
  database = await storage.getItem('database');
  if (!database) {
    database = {
      users: []
    }
  }

  for (const user of database.users) {
    // const sName = await slackController.getName(user.sAuth);
    // logger.info(sName);
    // const gName = await googleController.getUserName(user.gAuth);
    // logger.info(gName);
    logger.info(`Found existing user: ${user.gName} (${user.sName})`);
    // try {
    //   await setStatus(user);
    // } catch (error) {
    //   const exception = makeException(error);
    //   logger.error(`Error: ${exception.errorId}`);
    //   logger.error(exception.error);
    // }
  }
}
setupStorage();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({secret: secrets.sessionKey}));
const httpsServer = https.createServer(httpsOptions, app);

hbs.registerPartials(path.join(__dirname, '../', 'templates', 'partials'), () => {});
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, '../', 'templates'));

app.use('/assets', express.static(path.join(__dirname, '../', 'assets')));

// Handle the start of the process
app.get('/', async (req, res) => {
  // Check if the current user has already got tokens in the session
  if (req.session.googletoken && req.session.gid) {
    if (req.session.slacktoken) {
      try {
        const foundUser = getFromDatabase(req.session.gid);
        if (foundUser) {
          await setStatus(foundUser);
        } else {
          // Probably first time going through the flow, add them in
          let newUser: User = {
            gId: 'Unknown',
            gName: 'Unknown',
            gAuth: req.session.googletoken,
            sAuth: req.session.slacktoken,
            sName: undefined,
            useOOO: true,
            useDefault: true,
            useFocus: true,
            useLocation: true
          }
          await addToDatabase(newUser.gAuth, newUser.sAuth, newUser.sName, newUser.useOOO, newUser.useDefault, newUser.useFocus, newUser.useLocation);
          await setStatus(newUser);
        }
        res.render('complete');
        return;
      } catch (error) {
        const exception = makeException(error);
        res.locals = {
          error: exception.errorId
        }
        logger.error(`Error: ${exception.errorId}`);
        logger.error(exception.error);
        res.render('error');
        return;
      }
    }
    res.redirect('/googleauth');
    return;
  }

  res.locals = {
    auth_url: googleAuthUrl
  }
  res.render('index');
  return;
});

// Handle a user's request to cancel
app.get('/cancel', async (req, res) => {
  req.session.wantsCancel = true;
  // Check if the current user has already got tokens in the session
  if (req.session.googletoken) {
    const gId = await getUserId(req.session.googletoken);
    const foundIndex = database.users.findIndex((u) => u.gId == gId);
    if (foundIndex >= 0) {
      try {
        await revokeToken(req.session.googletoken);
      } catch (error) {
        logger.error('Failed to revoke Google token, but still removing from local database');
      }
      database.users.splice(foundIndex, 1);
      storage.setItem('database', database);
      logger.info(`Removed ${gId} from the database`);
      req.session.wantsCancel = false;
      req.session.googletoken = undefined;
      req.session.slacktoken = null;
      req.session.gid = null;
      res.render('cancelled');
      return;
    }
    try {
      await revokeToken(req.session.googletoken);
    } catch (error) {
      logger.error('Failed to revoke Google token, not in local database');
    }
    req.session.wantsCancel = false;
    req.session.googletoken = undefined;
    const errorId = crypto.randomUUID();
    res.locals = {
      error: errorId
    }
    logger.error(`Error: ${errorId}`);
    logger.error('Cancellation attempt failed for token:');
    logger.error(req.session.googletoken);
    logger.error(`Google ID: ${gId}`);
    res.render('cancelfail');
    return;
  }
  // Send the user to the auth URL if they don't have a token
  res.redirect(googleAuthUrl);
  return;
});

app.get('/preferences', async (req, res) => {
  // Check if the current user has already got tokens in the session
  if (req.session.gid) {
    const foundUser = getFromDatabase(req.session.gid);
    if (foundUser) {
      res.locals = {
        ooo: foundUser.useOOO ? 'checked="true"' : "",
        default: foundUser.useDefault ? 'checked="true"' : "",
        focus: foundUser.useFocus ? 'checked="true"' : "",
        location: foundUser.useLocation ? 'checked="true"' : "",
        complete: ""
      }
      res.render('preferences');
      return;
    } else {
      const errorId = crypto.randomUUID();
      res.locals = {
        error: errorId
      }
      logger.error(`Error: ${errorId}`);
      logger.error(`Unable to find a user in the database with gID: ${req.session.gid}`);
      res.render('error');
      return;
    }
  }

  res.render('preferencesfail');
});

app.post('/preferences', async (req, res) => {
  // Check if the current user has already got tokens in the session
  if (req.session.gid) {
    const foundUser = getFromDatabase(req.session.gid);
    if (foundUser) {
      const useOOO = req.body.ooo === 'on';
      const useDefault = req.body.default === 'on';
      const useFocus = req.body.focus === 'on';
      const useLocation = req.body.location === 'on';
      await addToDatabase(foundUser.gAuth, foundUser.sAuth, foundUser.sName, useOOO, useDefault, useFocus, useLocation);
      res.locals = {
        ooo: useOOO ? 'checked="true"' : "",
        default: useDefault ? 'checked="true"' : "",
        focus: useFocus ? 'checked="true"' : "",
        location: useLocation ? 'checked="true"' : "",
        complete: "Preferences saved successfully"
      }
      res.render('preferences');
      return;
    } else {
      const errorId = crypto.randomUUID();
      res.locals = {
        error: errorId
      }
      logger.error(`Error: ${errorId}`);
      logger.error(`Unable to find a user in the database with gID: ${req.session.gid}`);
      res.render('error');
      return;
    }
  }

  res.render('preferencesfail');
});

// Handle Google's OAuth redirect
app.get('/googleauth', async (req, res) => {
  if (req.session.wantsCancel) {
    if (req.session.googletoken) {
      res.redirect('/cancel');
      return;
    }
    const qs = new url.URL(req.url, baseUrl).searchParams;
    const code = qs.get('code');

    if (!code) {
      req.session.wantsCancel = false;
      logger.info('No Google code present in URL when trying to cancel');
      res.redirect('/');
      return;
    }

    // Now that we have the code, use that to acquire tokens.
    try {
      const googleToken = await googleCodeToToken(code);
      req.session.googletoken = googleToken;
      res.redirect('/cancel');
      return;
    } catch (error) {
      req.session.wantsCancel = false;
      const exception = makeException(error);
      res.locals = {
        error: exception.errorId
      }
      logger.error(`Error: ${exception.errorId}`);
      logger.error(`Unable to translate URL code to Google token`);
      logger.error(exception.error);
      res.render('error');
      return;
    }
  }
  // Check if the current user has already got tokens in the session
  if (req.session.googletoken && req.session.gid) {
    if (req.session.slacktoken) {
      res.redirect('/');
      return;
    }
    res.locals = {
      auth_url: slackAuthUrl.toString()
    }
    res.render('googleauth');
    return;
  }
  // acquire the code from the querystring, and close the web server.
  const qs = new url.URL(req.url, baseUrl).searchParams;
  const code = qs.get('code');

  if (!code) {
    logger.info('No Google code present in URL');
    res.redirect('/');
    return;
  }
  logger.info(`Google code acquired`);

  // Now that we have the code, use that to acquire tokens.
  let googleToken;
  try {
    googleToken = await googleCodeToToken(code);
  } catch (error) {
    const exception = makeException(error);
    res.locals = {
      error: exception.errorId
    }
    logger.error(`Error: ${exception.errorId}`);
    logger.error(`Unable to translate URL code to Google token`);
    logger.error(exception.error);
    res.render('error');
    return;
  }

  // Make sure to set the credentials on the OAuth2 client.
  logger.info('Google token acquired.');
  req.session.googletoken = googleToken;
  try {
    const gId = await getUserId(googleToken);
    req.session.gid = gId;
    res.locals = {
      auth_url: slackAuthUrl.toString()
    }
    res.render('googleauth');
    return;
  } catch (error) {
    const exception = makeException(error);
    res.locals = {
      error: exception.errorId
    }
    logger.error(`Error: ${exception.errorId}`);
    logger.error(`Unable to translate URL code to Google token`);
    logger.error(exception.error);
    res.render('error');
    return;
  }
});

// Handle Slack's OAuth redirect
app.get('/slackauth', async (req, res) => {
  // Check if the current user has already got tokens in the session
  if (req.session.googletoken && req.session.gid) {
    if (req.session.slacktoken) {
      res.redirect('/');
      return;
    }
  } else {
    res.redirect('/');
    return;
  }

  // acquire the code from the querystring, and close the web server.
  const qs = new url.URL(req.url, baseUrl).searchParams;
  const code = qs.get('code');

  if (!code) {
    logger.info('No Slack code present in URL');
    res.redirect('/');
    return;
  }
  logger.info(`Slack code acquired`);

  try {
    const userToken = await slackCodeToToken(code);
    logger.info('Slack token acquired.');
    req.session.slacktoken = userToken;
    res.redirect('/');
    return;
  } catch (error) {
    const exception = makeException(error);
    res.locals = {
      error: exception.errorId
    }
    logger.error(`Error: ${exception.errorId}`);
    logger.error(`Unable to translate URL code to Slack token`);
    logger.error(exception.error);
    res.render('error');
    return;
  }
});

// Use the authenticated tokens to set the Slack user's status
async function setStatus(user: User) {
  let currentEvent: calendar_v3.Schema$Event | undefined = undefined;
  try {
    currentEvent = await getCurrentPriorityEvent(user.gAuth, user.useOOO, user.useDefault, user.useFocus, user.useLocation);
  } catch (error) {
    try {
      await addToDatabase(user.gAuth, user.sAuth, user.sName, user.useOOO, user.useDefault, user.useFocus, user.useLocation);
    } catch (error2) {
      const errorId = crypto.randomUUID();
      throw {
        errorId,
        error2
      }
    }
    const errorId = crypto.randomUUID();
    throw {
      errorId,
      error
    }
  }

  if (!currentEvent) {
    await addToDatabase(user.gAuth, user.sAuth, user.sName, user.useOOO, user.useDefault, user.useFocus, user.useLocation);
    return;
    // const errorId = crypto.randomUUID();
    // throw {
    //   errorId,
    //   error: `No events found to set status for ${user.gName}`
    // }
  }

  const statusText = getStatusTextFromEvent(currentEvent);
  const statusEmoji = getStatusEmojiFromEvent(currentEvent);

  if (!statusText || !statusEmoji) {
    await addToDatabase(user.gAuth, user.sAuth, user.sName, user.useOOO, user.useDefault, user.useFocus, user.useLocation);
    return;
  }

  try {
    const slackRes = await setSlackStatus(user.sAuth, statusText, statusEmoji, currentEvent);
    if (slackRes.ok) {
      const sName = `${slackRes.profile.first_name} ${slackRes.profile.last_name}`;
      logger.info(`Slack profile (${sName}) updated to ${statusText}!`);
      await addToDatabase(user.gAuth, user.sAuth, sName, user.useOOO, user.useDefault, user.useFocus, user.useLocation);
      return;
    } else {
      const errorId = crypto.randomUUID();
      throw {
        errorId,
        error: slackRes.error
      }
    }
  } catch (error) {
    const errorId = crypto.randomUUID();
    throw {
      errorId,
      error
    }
  }
}

// Add the user to the database (or make sure their entry is up to date)
async function addToDatabase(gAuth: Credentials, sAuth: string, sName: string | undefined, useOOO: boolean, useDefault: boolean, useFocus: boolean, useLocation: boolean) {
  let gData = null;
  try {
    gData = await getUserData(gAuth);
  } catch (error) {
    const errorId = crypto.randomUUID();
    throw {
      errorId,
      error
    }
  }
  if (!gData.id || !gData.name) {
    const errorId = crypto.randomUUID();
    throw {
      errorId,
      error: 'Could not get user ID or name, unable to store user in database'
    }
  }
  // const sName = await slackController.getName(sAuth);
  let newUser: User = {
    sAuth,
    gAuth,
    sName: sName,
    gId: gData.id,
    gName: gData.name,
    useOOO,
    useDefault,
    useFocus,
    useLocation
  }
  const foundUser = database.users.find((u) => u.gId == newUser.gId);
  if (foundUser) {
    // Copy old Refresh Token if needed
    if (!newUser.gAuth.refresh_token) {
      newUser.gAuth.refresh_token = foundUser.gAuth.refresh_token ?? "";
    }
    foundUser.gAuth = newUser.gAuth;
    foundUser.gName = newUser.gName;
    foundUser.sName = newUser.sName;
    foundUser.sAuth = newUser.sAuth;
    foundUser.useOOO = newUser.useOOO;
    foundUser.useDefault = newUser.useDefault;
    foundUser.useFocus = newUser.useFocus;
    foundUser.useLocation = newUser.useLocation;
    logger.info(`Updated ${foundUser.gName} (${foundUser.sName}) in the database`);
  } else {
    database.users.push(newUser);
    logger.info(`Added ${newUser.gName} (${newUser.sName}) to the database`);
  }
  try {
    await storage.setItem('database', database);
  } catch (error) {
    const errorId = crypto.randomUUID();
    throw {
      errorId,
      error
    }
  }
}

async function revokeToken(gAuth: Credentials) {
  return axios({
    url: 'https://oauth2.googleapis.com/revoke',
    method: 'POST',
    headers: {
      "Content-Type": 'application/x-www-form-urlencoded'
    },
    data: {
      "token": gAuth.refresh_token ?? gAuth.access_token
    }
  });
}

function getFromDatabase(gId: string) {
  return database.users.find((u) => u.gId == gId);
}

function isException(error: unknown): error is Exception {
  let exception = error as Exception;
  return exception.errorId !== undefined && exception.error !== undefined;
}

function makeException(error: any): Exception {
  if (isException(error)) return error;
  const exception: Exception = {
    errorId: crypto.randomUUID(),
    error: JSON.stringify(error)
  }
  return exception;
}

// const job = 
schedule.scheduleJob('01,16,31,46 07-17 * * 1-5', async () => {
  for (const user of database.users) {
    try {
      await setStatus(user);
    } catch (error) {
      const exception = makeException(error);
      logger.error(`Failed to set status of ${user.gName} (${user.sName}) ${user.gId}`);
      logger.error(exception.error);
    }
  }
});

if (secrets.development) {
  app.listen(httpsPort, () => {
    logger.info(`*DEVELOPMENT* Slack <- GCalendar sync app listening on port ${httpsPort}`)
  });
} else {
  httpsServer.listen(httpsPort, () => {
    logger.info(`Slack <- GCalendar sync app listening on port ${httpsPort}`)
  });
}

export {
  logger
}
