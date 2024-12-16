import { Credentials } from 'google-auth-library';
import {calendar_v3, google} from 'googleapis';
import moment = require('moment');
import crypto = require('crypto');
import { logger } from '.';

const secrets = require('./secrets.json');

// Download your OAuth2 configuration from the Google
const googleCredentials = require('./google-credentials.json');

// If modifying these scopes, delete token.json.
const authScopes = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// -- Google
// create an oAuth client to authorize the API call.  Secrets are kept in a `credentials.json` file,
// which should be downloaded from the Google Developers Console.
const oauthClient = new google.auth.OAuth2(
  googleCredentials.web.client_id,
  googleCredentials.web.client_secret,
  `${secrets.baseUrl}/googleauth`
);
// Generate the url that will be used for the consent dialog.
const googleAuthUrl = oauthClient.generateAuthUrl({
  access_type: 'offline',
  scope: authScopes,
  redirect_uri: `${secrets.baseUrl}/googleauth`
});

// Takes an OAuth2 code and gets a User Token
async function codeToToken(code: string) {
  try {
    const googleResponse = await oauthClient.getToken(code);
    if (googleResponse.tokens) {
      return googleResponse.tokens;
    } else {
      const errorId = crypto.randomUUID();
      throw {
        errorId,
        error: `Google token was returned empty`
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

async function getCurrentGenericEvent(gAuth: Credentials, eventType: string): Promise<calendar_v3.Schema$Event | undefined> {
  // Try to get Google OAuth
  const oAuth2Client = new google.auth.OAuth2(
    googleCredentials.web.client_id,
    googleCredentials.web.client_secret,
    `${secrets.baseUrl}/googleauth`
  );
  oAuth2Client.setCredentials(gAuth);

  // Setup the Calendar API object
  const calendar = google.calendar({
    version: 'v3',
    auth: oAuth2Client
  });
  // Get the current workingLocation event for the authenticated user
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    timeMax: moment().add(1, 'minute').toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: 'startTime',
    eventTypes: [eventType]
  });
  const events = res.data.items;
  if (!events || events.length === 0) {
    return;
  }
  // Filter the events so that it is only ones related to the user
  let acceptedEvents = events.filter(event => {
    // If the event has no attendees, then it is likely OOO or workingLocation, so let it through
    if (!event.attendees || event.attendees.length === 0) return true;
    // Locate the relevant user in the list of attendees, not entirely sure this works
    var thisAttendee = event.attendees?.find(attendee => attendee.self === true);
    // Allow events that are accepted or tentatively accepted
    return thisAttendee?.responseStatus === 'accepted' || thisAttendee?.responseStatus === 'tentative';
  });
  if (!acceptedEvents || acceptedEvents.length === 0) {
    return;
  }
  acceptedEvents.sort(eventSort);
  return acceptedEvents[0];
}

// Gets the first (assuming today's) working location for the authenticated user
async function getCurrentOutOfOfficeEvent(gAuth: Credentials): Promise<calendar_v3.Schema$Event | undefined> {
  return await getCurrentGenericEvent(gAuth, 'outOfOffice');
}

// Gets the first (assuming today's) working location for the authenticated user
async function getCurrentDefaultEvent(gAuth: Credentials): Promise<calendar_v3.Schema$Event | undefined> {
    return await getCurrentGenericEvent(gAuth, 'default');
}

// Gets the first (assuming today's) working location for the authenticated user
async function getCurrentFocusEvent(gAuth: Credentials): Promise<calendar_v3.Schema$Event | undefined> {
  return await getCurrentGenericEvent(gAuth, 'focusTime');
}

// Gets the first (assuming today's) working location for the authenticated user
async function getCurrentWorkingLocationEvent(gAuth: Credentials): Promise<calendar_v3.Schema$Event | undefined> {
  return await getCurrentGenericEvent(gAuth, 'workingLocation');
}

async function getCurrentPriorityEvent(gAuth: Credentials, useOOO: boolean, useDefault: boolean, useFocus: boolean, useLocation: boolean): Promise<calendar_v3.Schema$Event | undefined> {
  /*
    ** Ordering Logic
    OOO
    Default
    Focus
    Working location

    Timed over all day
    Single over recurring
    Later start date over earlier
    Shorter duration over longer
    More recently created over older
  */
  if (useOOO) {
  const currentOOO = await getCurrentOutOfOfficeEvent(gAuth);
  if (currentOOO) {
    return currentOOO;
  }
  }
  if (useDefault) {
    const currentDefaultEvent = await getCurrentDefaultEvent(gAuth);
    if (currentDefaultEvent) {
      return currentDefaultEvent;
    }
  }
  if (useFocus) {
    const currentFocus = await getCurrentFocusEvent(gAuth);
    if (currentFocus) {
      return currentFocus;
    }
  }
  if (useLocation) {
    const currentLocation = await getCurrentWorkingLocationEvent(gAuth);
    if (currentLocation) {
      return currentLocation;
    }
  } 
  return;
}

function getStatusTextFromEvent(event: calendar_v3.Schema$Event) {
  switch (event.eventType) {
    case 'workingLocation': {
      if (event.workingLocationProperties) {
        const workingLocationType = event.workingLocationProperties.type;
        if (workingLocationType === 'homeOffice') {
          return 'Working from Home';
        } else if (workingLocationType === 'officeLocation') {
          return 'In the Office';
        } else if (workingLocationType === 'customLocation') {
          if (event.workingLocationProperties.customLocation) {
            return event.workingLocationProperties.customLocation.label ?? event.summary;
          }
          return event.summary
        }
      }
      return null;
    }
    case 'default': {
      return 'In a Meeting';
    }
    case 'outOfOffice': {
      return 'Out of Office';
    }
    case 'focusTime': {
      return 'Focus Time';
    }
  }
}

function getStatusEmojiFromEvent(event: calendar_v3.Schema$Event) {
  switch (event.eventType) {
    case 'workingLocation': {
      if (event.workingLocationProperties) {
        const workingLocationType = event.workingLocationProperties.type;
        if (workingLocationType === 'homeOffice') {
          return ':house_with_garden:';
        } else if (workingLocationType === 'officeLocation') {
          return ':office:';
        }
      }
      return null;
    }
    case 'default': {
      return ':spiral_calendar_pad:';
    }
    case 'outOfOffice': {
      return ':no_entry:';
    }
    case 'focusTime': {
      return ':alarm_clock:';
    }
  }
}

// Gets the user's name from their Google info
async function getUserData(gAuth: Credentials) {
    // Try to get Google OAuth
    const oAuth2Client = new google.auth.OAuth2(
      googleCredentials.web.client_id,
      googleCredentials.web.client_secret,
      `${secrets.baseUrl}/googleauth`
    );
    oAuth2Client.setCredentials(gAuth);

    const oauth2 = google.oauth2({
        auth: oAuth2Client,
        version: 'v2'
    });

    const {data} = await oauth2.userinfo.get();
    return data;
}

// Gets the user's ID from their Google info
async function getUserId(gAuth: Credentials) {
    // Try to get Google OAuth
    const oAuth2Client = new google.auth.OAuth2(
      googleCredentials.web.client_id,
      googleCredentials.web.client_secret,
      `${secrets.baseUrl}/googleauth`
    );
    oAuth2Client.setCredentials(gAuth);

    const oauth2 = google.oauth2({
        auth: oAuth2Client,
        version: 'v2'
    });

    try {
      const {data} = await oauth2.userinfo.get();
      if (data.id) {
        return data.id;
      } else {
        const errorId = crypto.randomUUID();
        throw {
          errorId,
          error: `Google user ID was returned empty`
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

// Gets the user's name from their Google info
async function getUserName(gAuth: Credentials) {
    // Try to get Google OAuth
    const oAuth2Client = new google.auth.OAuth2(
      googleCredentials.web.client_id,
      googleCredentials.web.client_secret,
      `${secrets.baseUrl}/googleauth`
    );
    oAuth2Client.setCredentials(gAuth);

    const oauth2 = google.oauth2({
        auth: oAuth2Client,
        version: 'v2'
    });

    const {data} = await oauth2.userinfo.get();
    return data.name;
}

function eventSort(a: calendar_v3.Schema$Event, b: calendar_v3.Schema$Event) {
  /*
    ** Ordering Logic
    Timed over all day
    Single over recurring
    Later start date over earlier
    Shorter duration over longer
    More recently created over older
  */
  if (a.start && a.start.dateTime && b.start && b.start.dateTime || a.start && a.start.date && b.start && b.start.date) {
    // Both either timed or all day
    if (a.recurringEventId === b.recurringEventId || (a.recurringEventId && b.recurringEventId)) {
      // Both are either recurring or single events
      if (a.start.dateTime === b.start.dateTime || a.start.date === b.start.date) {
        // Both start at the same time
        if (!a.end || !b.end) {
          logger.error("Event didn't have an end date");
          return -1;
        }
        const aDuration = a.end.dateTime && a.start.dateTime ? moment(a.end.dateTime).unix() - moment(a.start.dateTime).unix() : moment(a.end.date).unix() - moment(a.start.date).unix();
        const bDuration = b.end.dateTime && b.start.dateTime ? moment(b.end.dateTime).unix() - moment(b.start.dateTime).unix() : moment(b.end.date).unix() - moment(b.start.date).unix();
        if (aDuration === bDuration) {
          // Both same duration
          // Use created datetime, more recent first
          return moment(a.created) > moment(b.created) ? -1 : 1;
        }
        // Use duration, shorter first
        return aDuration < bDuration ? -1 : 1;
      }
      // Use start time, later first
      if (a.start.dateTime && b.start.dateTime) {
        // Timed events
        return a.start.dateTime > b.start.dateTime ? -1 : 1;
      }
      // All day event
        if (!a.start.date || !b.start.date) {
          logger.error("Event didn't have an start date");
          return -1;
        }
      return a.start.date > b.start.date ? -1 : 1;
    }
    // Use recurring vs single, single first
    return b.recurringEventId ? -1 : 1;
  }
  // Use timed vs all day, timed first
  if (!a.start) {
    logger.error("Event didn't have a start date");
    return -1;
  }
  return a.start.dateTime ? -1 : 1;
}

export {
    codeToToken,
    getCurrentPriorityEvent,
    getStatusTextFromEvent,
    getStatusEmojiFromEvent,
    getUserData,
    getUserId,
    getUserName,
    googleAuthUrl
}
