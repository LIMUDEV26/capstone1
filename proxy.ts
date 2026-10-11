import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Verify protected page requests before Next.js serves their HTML shell.
 *
 * The PHP API remains the source of truth for the session. This check is only
 * a defence-in-depth page gate; every data endpoint must continue enforcing
 * its own authentication and authorization.
 */
export function proxy(request: NextRequest) {
  const loginUrl = new URL('/', request.url);
  loginUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);

  // Do not perform a network auth round-trip on every client navigation. A
  // slow PHP response previously made this proxy time out and redirect a valid
  // user to login. Cookie presence keeps anonymous requests away from the app
  // shell; the AuthProvider and every API endpoint still validate the session.
  const hasSessionCookie = Boolean(
    request.cookies.get('PHPSESSID')?.value || request.cookies.get('llb_session')?.value,
  );
  if (hasSessionCookie) return NextResponse.next();

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/analytics/:path*',
    '/branches/:path*',
    '/calendar/:path*',
    '/cash-advance/:path*',
    '/clients/:path*',
    '/contracts/:path*',
    '/create.admin/:path*',
    '/dashboard/:path*',
    '/deduction-types/:path*',
    '/documents/:path*',
    '/employees/:path*',
    '/manager/:path*',
    '/notifications/:path*',
    '/payroll-management/:path*',
    '/profile/:path*',
    '/projects/:path*',
    '/reports/:path*',
    '/services/:path*',
    '/settings/:path*',
    '/shift-schedules/:path*',
    '/tasks/:path*',
    '/users/:path*',
  ],
};
