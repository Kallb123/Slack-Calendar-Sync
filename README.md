# Slack Calendar Sync

Reads a user's Google Calendar to locate the most relevant current activity and updates their Slack profile with a matching status.

![Image of homepage](docs/index.png)

## Getting Started

### Prerequisites

* VS Code - Code editor or equivelant
* Docker or NodeJS

### Installing

1. Clone the repo
1. if not using containerisation. call `npm i` in the project folder to get all the node dependencies.

### Configuring

#### Application

The application is configured using a `secrets.json` file within the `/dist` directory.
An example `secrets.json.example` is provided in the root of the repo.

| Parameter | Description | Type | Default |
| -- | -- | -- | -- |
| `sessionKey` | Provides a key to sign the session ID cookie. Can be any value. See [express-session](https://www.npmjs.com/package/express-session#secret) | `any` | `"secure key"` |
| `https` | Determines whether HTTPS is enabled, and by extension whether to attempt to load certificates. If `false-y` HTTPS is disabled. If `true` then HTTPS is enabled and the application will attempt to load `private.key` and `public.cert` from the `/dist` directory | `boolean` | `true` |
| `host` | The location where the application is being hosted. Provides the OAuth platforms somewhere to redirect the user during the auth flow. This may need to be secured with HTTPS for it to function. | `string` | `"localhost"` |
| `port` | The port where the application is being hosted. This will be the port the application listens to inside the container. | `number` | `3000` |
| `baseUrl` | This parameter can be used to work with more complex networking, for example where the URL the user sees includes a different port to the one the application is listening on, or where https is being used but handles outside the container. | `string` | If left blank, will default to `"{https?}://{host}:{port}"`.

#### Cloud Credentials

There are also two credential files requires to be in the `dist` folder. They are generally provided by the Google Cloud Console and Slacks Developer Portal.

`google-credentials.yaml`

Takes the form: `{"web":{"client_id":"","project_id":"","auth_uri":"","token_uri":"","auth_provider_x509_cert_url":"","client_secret":"","redirect_uris":[""],"javascript_origins":[""]}}`

`slack-credentials.yaml`

Takes the form: `{"slackClientId":"","slackClientSecret":"","slackRedirectURL":"","slackTeamId":""}`

`slackTeamId` is required for non-distributed (development) Slack apps. Find it in your Slack workspace URL (`https://app.slack.com/client/TXXXXXXXX`) or via **Settings > About this workspace**. Leave it out or set it to `null` for distributed apps.

### Development

#### Containerised

Call `docker compose build` in the project to build the image.

#### Un-containerised

Run `npm run build` and then `npm run start` to have the environment running.
The interface should be available at [localhost](https://localhost:3000).

#### TLS

A private key and certificate will be required for the OAuth flows to work properly, these can be generated for `localhost` and loaded within the app as `/dist/private.key` and `/dist/public.cert`.

If SSL is not possible, you may be able to use the `host` as another URL and then when the auth flow completes, change the URL in the browser to your unsecured instance. This is why the `host` parameter includes the protocol, as the local instance may have HTTPS disabled but the `host` specified for the OAuth flow will need HTTPS enabled. Note that the `port` parameter will be used for both the local running service and the `baseUrl` given to the OAuth (which will usually be the same but may different if local HTTPS is a problem).

### Building

Call `docker compose build` in the project to build the image.

Alternatively, without containerisation, the application is developed in TypeScript, run `npm run build` to generate the JavaScript source in the `dist` folder.

### Running

Ensure valid SSL credentials are present and then `docker compose up`.
Alternatively, without containerisation, call `npm run start` to run the application.

### Testing

No tests are implemented for this project.

## Contributing

Development practice follows [GitHub flow](https://guides.github.com/introduction/flow/).

### Coding Style

| Language | Standard |
| -- | -- |
| Javascript | [AirBnB](https://github.com/airbnb/javascript) |

## Versioning

This project is using [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repositiory](https://github.com/your/project/tags).

## Authors

* **Kallum Burgin** - *Software Engineer*

See also the list of [contributors](https://github.com/Kallb123/Slack-Calendar-Sync/graphs/contributors) who participated in this project.

## Acknowledgments

*This markdown sheet is quite handy! [Link](https://github.com/adam-p/markdown-here/wiki/Markdown-Cheatsheet)*
