import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // withComponentInputBinding binds a route's `data` (e.g. the placeholder
    // title) straight to a matching component @Input.
    provideRouter(routes, withComponentInputBinding()),
    // The client talks to the NestJS backend over HTTP; withFetch keeps it on
    // the platform fetch so withCredentials carries the session cookie.
    provideHttpClient(withFetch()),
  ],
};
