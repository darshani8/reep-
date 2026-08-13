import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // The client talks to the NestJS backend over HTTP; withFetch keeps it on
    // the platform fetch so withCredentials carries the session cookie.
    provideHttpClient(withFetch()),
  ],
};
