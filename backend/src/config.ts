import 'dotenv/config';
export const config = {
  port: Number(process.env.PORT || 3001),
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  tenantId: process.env.MICROSOFT_TENANT_ID || '',
  clientId: process.env.MICROSOFT_CLIENT_ID || '',
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
  redirectUri: process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:5173/auth/callback',
  production: process.env.NODE_ENV === 'production',
};
export const authConfigured = Boolean(config.tenantId && config.clientId && config.clientSecret);
