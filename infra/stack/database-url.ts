/**
 * The connection string of a role on the managed database. `verify-full` checks the certificate chain against the authorities Node trusts (the image adds Amazon's database
 * bundle through NODE_EXTRA_CA_CERTS) and the certificate's name against the host: the connection is encrypted and the server is the one named, never merely encrypted.
 */
export function databaseUrl(user: string, password: string, host: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}?sslmode=verify-full`;
}

/** Where the image keeps the bundle (see the Dockerfile). */
export const RDS_CA_BUNDLE = '/app/certs/global-bundle.pem';
