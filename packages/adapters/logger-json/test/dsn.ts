/** A connection string of the shape a redaction test needs, made from its user information and the rest, so that no test file holds a credentialed URL as a literal. */
export const dsn = (userInfo: string, rest: string): string => `postgres://${userInfo}@${rest}`;
