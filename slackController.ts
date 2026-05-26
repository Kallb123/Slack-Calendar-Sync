const url = require('url');
const axios = require('axios');
import crypto = require('crypto');
import moment = require('moment');
const slackCredentials = require('./slack-credentials.json');
import { calendar_v3 } from 'googleapis';
import { logger } from '.';

// -- Slack
const slackAuthUrl = new url.URL('https://slack.com/oauth/v2/authorize');
const searchParams = new url.URLSearchParams();
searchParams.append('client_id', slackCredentials.slackClientId);
searchParams.append('user_scope', 'users.profile:write');
searchParams.append('redirect_uri', slackCredentials.slackRedirectURL);
if (slackCredentials.slackTeamId) {
  searchParams.append('team', slackCredentials.slackTeamId);
}
slackAuthUrl.search = searchParams.toString();

// Takes an OAuth2 code and gets a User Token
async function codeToToken(code: string) {
  try {
    const slackRes = await axios({
        url: 'https://slack.com/api/oauth.v2.access',
        method: 'POST',
        headers: {
          "Content-Type": 'application/x-www-form-urlencoded'
        },
        data: {
          "code": code,
          "client_id": slackCredentials.slackClientId,
          "client_secret": slackCredentials.slackClientSecret,
          'redirect_uri': slackCredentials.slackRedirectURL
        }
      });
    if (slackRes.data.authed_user.access_token) {
      return slackRes.data.authed_user.access_token;
    } else {
      const errorId = crypto.randomUUID();
      logger.error(slackRes);
      throw {
        errorId,
        error: `Failed to convert Slack code to token`
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

// Updates the status of the authenticated Slack user by checking the working location
async function setStatus(sAuth: string, statusText: string, statusEmoji: string, currentEvent: calendar_v3.Schema$Event) {
  // Set up the profile status data
  const statusExpiry = moment(currentEvent.end?.dateTime ?? currentEvent.end?.date ?? '').toDate();
  const profileData = {
    "status_text": statusText,
    "status_emoji": statusEmoji,
    "status_expiration": Math.floor(statusExpiry.getTime() / 1000)
  }

  // Send request to Slack
  const slackRes = await axios({
    url: 'https://slack.com/api/users.profile.set',
    method: 'POST',
    headers: {
      'Content-Type': "application/json; charset=utf-8",
      'Authorization': `Bearer ${sAuth}`
    },
    data: {
      "profile": profileData
    }
  });
  return slackRes.data;
}

// Cannot currently be used due to missing scope
async function getName(sAuth: string) {
    // Send request to Slack
    const slackRes = await axios({
      url: 'https://slack.com/api/users.profile.get',
      method: 'GET',
      headers: {
        'Content-Type': "application/json; charset=utf-8",
        'Authorization': `Bearer ${sAuth}`
      }
    });
    return slackRes.data.profile.real_name;
}

export {
    codeToToken,
    setStatus,
    getName,
    slackAuthUrl
}
