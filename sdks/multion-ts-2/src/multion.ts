// Vendors
import axios from 'axios';
import path from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  createWriteStream,
} from 'fs';
import {
  AuthorizationCode,
  AuthorizationTokenConfig,
  Token,
} from 'simple-oauth2';
import express, { Request } from 'express';
import sharp from 'sharp';
// Utils
import { niceLog } from './utils/niceLog';
import { fileURLToPath } from 'url';

interface Secrets {
  MULTION_CLIENT_ID: string;
  MULTION_CLIENT_SECRET: string;
}

interface MultionParams {
  verbose?: boolean;
  tokenFile?: string;
}

interface SessionDataParams {
  input: string;
  url: string;
}

interface SessionSuccesfulResponse {
  url: string;
  screenshot: string;
  message: string;
  status: string;
  session_id: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Multion {
  private clientId: string;
  private clientSecret: string;
  private secretsFilePath: string;
  private verbose?: boolean;
  private tokenURL = 'https://auth.multion.ai/oauth2/token';
  private apiURL = `https://api.multion.ai`;
  private redirectURI = 'http://localhost:8000/callback';
  private token?: Token;
  private tokenFilePath: string;
  private defaultTokenFileName = 'multion_token.txt';

  constructor(params: MultionParams = {}) {
    const { tokenFile } = params;
    this.secretsFilePath = path.join(__dirname, '../secrets.json');
    const secrets = this.getSecrets();
    this.clientId = secrets.MULTION_CLIENT_ID;
    this.clientSecret = secrets.MULTION_CLIENT_SECRET;
    const verbose =
      params.verbose === undefined
        ? process.env.VERBOSE === 'true'
        : params.verbose;

    this.verbose = verbose;
    this.tokenFilePath = path.resolve(
      __dirname,
      '..', // One folder down to the root of the project
      tokenFile || this.defaultTokenFileName,
    );
  }

  /**
   * Retrieves the secrets from the `secrets.json` file.
   * @returns An object containing the secrets.
   * @throws An error if the `secrets.json` file is not found.
   */
  private getSecrets() {
    const secrets: Secrets = JSON.parse(
      readFileSync(this.secretsFilePath, 'utf8'),
    );

    if (!secrets) {
      throw new Error(
        'No `secrets.json` file found. Be sure to create one in the root of the project.',
      );
    }

    return secrets;
  }

  /**
   * @param title - The title of the log
   * @param message - The message to log
   * @param error - Optional parameter to log as an error
   */
  readonly log = (title: string, message: any, error?: boolean): void => {
    if (this.verbose) {
      const className = this.constructor.name;
      const fullTitle = `${className} - ${title}`;

      niceLog(fullTitle, message, undefined, error);
    }
  };

  /**
   * Returns an object with the login request parameters.
   * @param req - The request object.
   * @returns An object with the login request parameters.
   * @throws An error if the code parameter is missing or not a string.
   */
  private getLoginReqParams = (req: Request) => {
    const { code } = req.query;

    if (!code) {
      throw new Error('No code found in request params');
    }

    if (typeof code !== 'string') {
      throw new Error('Code is not a string');
    }

    return { code };
  };

  private setIsRemote = async (isRemote: boolean) => {
    try {
      if (!this.token) {
        throw new Error('You must log in before making API calls.');
      }

      const url = `${this.apiURL}/is_remote`;
      const headers = { Authorization: `Bearer ${this.token['access_token']}` };

      this.log('setIsRemote', `Turning MultiOn API remote to "${isRemote}"`);

      const response = await axios.post(url, { value: isRemote }, { headers });

      if (typeof response.data.is_remote !== 'boolean') {
        throw response.data;
      }

      this.log('setIsRemote', `MultiOn API remote now set to "${isRemote}"`);

      return response;
    } catch (error: any) {
      const errorMsg = error.message
        ? `Failed to check if the API is running remotely: ${error.message}`
        : error;
      this.log('setIsRemote - Error', errorMsg, true);
      throw error;
    }
  };

  /**
   * Logs in the user by initiating the OAuth2 authorization flow and obtaining an access token.
   * If the user is already logged in, this method does nothing.
   * @returns A Promise that resolves to a string indicating that the login process has completed.
   * @throws An error if the login process fails.
   */
  readonly login = async () => {
    try {
      if (this.token) {
        this.log('login', 'Already logged in');
        return;
      }

      const oauth = new AuthorizationCode({
        client: {
          id: this.clientId,
          secret: this.clientSecret,
        },
        auth: {
          authorizeHost: 'https://auth.multion.ai',
          authorizePath: '/oauth2/authorize',
          tokenHost: 'https://auth.multion.ai',
          tokenPath: '/oauth2/token',
        },
      });

      const authorizationUri = oauth.authorizeURL({
        redirect_uri: this.redirectURI,
      });
      const open = (await import('open')).default;
      open(authorizationUri);

      const app = express();
      const server = app.listen(8000, () => {
        this.log('login', 'Server listening on port 8000');
      });

      return new Promise((resolve, reject) => {
        app.get('/callback', async (req, res) => {
          try {
            const { code } = this.getLoginReqParams(req);
            const tokenParams: AuthorizationTokenConfig = {
              code,
              redirect_uri: this.redirectURI,
            };
            const result = await oauth.getToken(tokenParams);

            this.token = result.token;
            writeFileSync(this.tokenFilePath, JSON.stringify(this.token));

            this.log('login', 'Login successful!');

            // Ensuring is_remote is set to false to prevent bugs
            await this.setIsRemote(false);

            resolve('Login completed');
          } catch (error: any) {
            this.log('login - Error', error.message || error, true);
            reject(error);
          } finally {
            server.close();
          }

          res.send('<script>window.close()</script>');
        });
      });
    } catch (error: any) {
      this.log('login - Error', error.message || error, true);
      throw error;
    }
  };

  readonly post = async (
    url: string,
    data: SessionDataParams,
    tabId?: string,
  ) => {
    if (!this.token) {
      throw new Error('You must log in before making API calls.');
    }

    let headers = { Authorization: `Bearer ${this.token['access_token']}` };

    if (tabId) {
      url = `${this.apiURL}/sessions/${tabId}`;
    }

    let attempts = 0;

    while (attempts < 5) {
      this.log(`post - Running POST Attempt ${attempts + 1}`, {
        url,
        data,
      });

      try {
        const response = await axios.post(url, data, { headers });
        this.log(`post - Response Status: ${response.status}`, {
          data: response.data.response?.data || response.data,
          status: response.status,
          statusText: response.statusText,
        });

        if (response.status >= 200 && response.status < 400) {
          if (response.data.response.status === 'Error') {
            throw new Error(`Unknown error ocurred`);
          }
          return response.data.response.data as SessionSuccesfulResponse;
        } else if (response.status === 401) {
          this.log('login', 'Invalid token. Refreshing...');
          await this.refreshToken();
          headers['Authorization'] = `Bearer ${this.token['access_token']}`;
          continue;
        }
      } catch (error: any) {
        await this.refreshToken();
        const message =
          error.response.data || 'Request failed without a response';
        const status = error.response.status;

        this.log(`post - Error${status ? ` ${status}` : ''}`, message, true);

        throw new Error('Failed to get a valid response after 5 attempts');
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts += 1;
    }
  };

  readonly get = async () => {
    if (!this.token) {
      throw new Error('You must log in before making API calls.');
    }

    const headers = { Authorization: `Bearer ${this.token['access_token']}` };
    const url = `${this.apiURL}/sessions`;

    const response = await axios.get(url, { headers });
    return response.data.response.data;
  };

  readonly refreshToken = async () => {
    try {
      if (!this.token) {
        throw new Error('You must log in before refreshing the token.');
      }

      const auth = {
        username: this.clientId,
        password: this.clientSecret,
      };

      const data = {
        grant_type: 'refresh_token',
        refresh_token: this.token.refresh_token,
        redirect_uri: this.redirectURI,
      };

      const response = await axios.post(this.tokenURL, data, { auth });
      this.token = response.data;
      writeFileSync(this.tokenFilePath, JSON.stringify(this.token));
    } catch (error) {
      this.log(
        'refreshToken - Error',
        `Failed to refresh token: ${error}`,
        true,
      );
    }
  };

  readonly newSession = async (data: SessionDataParams) => {
    const url = `${this.apiURL}/sessions`;
    return await this.post(url, data);
  };

  readonly updateSession = async (
    sessionId: string,
    data: SessionDataParams,
  ) => {
    const url = `${this.apiURL}/session/${sessionId}`;
    return await this.post(url, data);
  };

  readonly listSessions = async () => {
    return await this.get();
  };

  readonly deleteToken = () => {
    if (existsSync(this.tokenFilePath)) {
      unlinkSync(this.tokenFilePath);
    } else {
      this.log(
        'deleteToken',
        'No active session found. Access token has already been revoked.',
      );
    }
  };

  readonly closeSession = async (tabId: string) => {
    try {
      if (!this.token) {
        throw new Error('You must log in before closing a session.');
      }

      const headers = { Authorization: `Bearer ${this.token['access_token']}` };
      const url = `${this.apiURL}/sessions/${tabId}`;

      const response = await axios.delete(url, { headers });

      if (response.status >= 200 && response.status < 400) {
        return response.data.response.data;
      } else {
        throw new Error(
          `Failed to close session. Status code: ${response?.status}`,
        );
      }
    } catch (error: any) {
      if (error.response) {
        const { data, status, headers } = error.response;
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        this.log(
          `closeSession - Response Error ${status}`,
          { data, headers },
          true,
        );
      } else if (error.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        this.log(`closeSession - Request Error`, error.request, true);
      } else {
        // Something happened in setting up the request that triggered an Error
        this.log(`closeSession - Error`, error.message, true);
      }
      this.log(`closeSession - Error Config`, error.config, true);
    }
  };

  readonly getScreenshot = async (
    response: any,
    height?: number,
    width?: number,
  ) => {
    try {
      const screenshot = response.screenshot;

      if (!screenshot) {
        throw new Error('No screenshot found in response');
      }

      const base64ImgBytes = screenshot.replace('data:image/png;base64,', '');
      const imgBuffer = Buffer.from(base64ImgBytes, 'base64');
      let resizedBuffer;
      if (height && width) {
        resizedBuffer = await sharp(imgBuffer)
          .resize(width, height)
          .png()
          .toBuffer();
      } else if (height) {
        resizedBuffer = await sharp(imgBuffer)
          .resize({ height })
          .png()
          .toBuffer();
      } else if (width) {
        resizedBuffer = await sharp(imgBuffer)
          .resize({ width })
          .png()
          .toBuffer();
      } else {
        resizedBuffer = imgBuffer; // no resizing
      }

      // If you want to save the image to a file
      // await sharp(resizedBuffer).toFile('output.png');

      // If you want to get the image data URL
      const imageDataURL = `data:image/png;base64,${resizedBuffer.toString(
        'base64',
      )}`;
      return imageDataURL;
    } catch (error: any) {
      this.log('getScreenshot - Error processing image', error.message, true);
      throw error;
    }
  };

  readonly getVideo = async (session_id: string) => {
    const url = `${this.apiURL}/sessionVideo/${session_id}`;
    try {
      if (!this.token) {
        throw new Error('You must log in before getting a video.');
      }

      const headers = { Authorization: `Bearer ${this.token['access_token']}` };

      const response = await axios.get(url, {
        headers,
        responseType: 'stream',
      });
      if (response.status >= 200 && response.status < 400) {
        const videoStream = response.data;
        const path = 'video.webm';
        const writer = createWriteStream(path);
        videoStream.pipe(writer);

        return new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } else {
        throw new Error(`Failed to get video. Status code: ${response.status}`);
      }
    } catch (error: any) {
      this.log('getVideo - Error', error.message || error, true);
      return null;
    }
  };

  readonly setApiUrl = (url: string) => {
    this.apiURL = url;
  };
}
