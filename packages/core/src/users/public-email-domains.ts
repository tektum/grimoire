/**
 * Public mailbox providers (docs/tenancy.md section 3.7): anybody can get an address there, so the domain says nothing about the organisation and a sign-in from it never
 * makes or joins a workspace. Lowercase, one entry per domain; `GRIMOIRE_REFUSED_EMAIL_DOMAINS` adds to it. The test pins the shape and a few members.
 */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es',
  'live.com', 'live.co.uk', 'live.fr', 'msn.com', 'passport.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es',
  'yahoo.com.br', 'yahoo.com.au', 'yahoo.ca', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com', 'proton.me', 'protonmail.com',
  'protonmail.ch', 'pm.me', 'tutanota.com', 'tutanota.de', 'tuta.io', 'tutamail.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'zoho.com', 'zohomail.com', 'gmx.com',
  'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 'mail.com', 'email.com', 'inbox.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'yandex.com', 'yandex.ru', 'rambler.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'btinternet.com', 'sky.com', 'virginmedia.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net',
  'libero.it', 'virgilio.it', 'tiscali.it', 't-online.de', 'freenet.de', 'seznam.cz', 'o2.pl', 'wp.pl', 'onet.pl', 'interia.pl', 'mailinator.com', 'guerrillamail.com',
  '10minutemail.com', 'yopmail.com',
];
