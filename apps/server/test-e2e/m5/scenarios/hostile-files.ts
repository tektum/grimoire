import { apiAs, errorCode, expectStatus, getFromStore, objectExists, pageIn, readyAttachment, scenario, sendToStore, signInAll, startUpload, textBytes } from '../support.ts';

// Files that try to be served as something they are not (R9.23): HTML and SVG with a script, declared as plain text, come back as `attachment` of type
// `application/octet-stream`; an SVG declared as such is refused; HTML bytes declared as a PNG are refused at completion and the object is removed.
const HTML = '<html><body><script>alert(document.cookie)</script></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

await scenario('hostile-files', 180_000, async (t) => { // timeout: about 30 requests and eight transfers to the store
  await signInAll();
  const bob = apiAs('bob');
  const carol = apiAs('carol');
  const open = await pageIn(true);

  for (const [label, text, name] of [['HTML', HTML, 'page.html'], ['SVG with a script', SVG, 'image.svg']] as const) {
    const bytes = textBytes(`${text}<!-- ${String(Math.random())} -->`);
    const file = await readyAttachment(bob, open.page, bytes, { fileName: name, contentType: 'text/plain' });
    for (const query of [{}, { download: 'false' as const }, { download: 'true' as const }]) {
      const link = expectStatus(await carol.GET('/v1/attachments/{id}', { params: { path: { id: file.id }, query } }), 200, `a link for the ${label}`);
      const served = await getFromStore(link.url);
      t.check((served.headers.get('content-disposition') ?? '').startsWith('attachment'), `the ${label} is served as an attachment (${JSON.stringify(query)})`);
      t.equal(served.headers.get('content-type'), 'application/octet-stream', `the ${label} is served as application/octet-stream (${JSON.stringify(query)})`);
      t.equal(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(bytes)), true, `the ${label} is served byte for byte`);
    }
  }

  const svg = await bob.POST('/v1/attachments', { body: { pageId: open.page, fileName: 'a.svg', contentType: 'image/svg+xml', size: SVG.length } });
  t.equal([svg.response.status, errorCode(svg)], [422, 'type_not_allowed'], 'an SVG declared as an SVG is refused');

  const html = textBytes(HTML);
  const lying = (await startUpload(bob, open.page, html, { fileName: 'x.png', contentType: 'image/png' })).body;
  if (lying === undefined) throw new Error('the declaration of a PNG was refused at the start');
  t.equal((await sendToStore(lying.upload, html)).status, 200, 'the store keeps the bytes: it does not know the type');
  const mismatch = await bob.POST('/v1/attachments/{id}/complete', { params: { path: { id: lying.id } } });
  t.equal([mismatch.response.status, errorCode(mismatch)], [422, 'type_mismatch'], 'HTML bytes declared as a PNG are refused at completion');
  t.equal(await objectExists(lying.id), false, 'and the object is gone');
  t.equal((await carol.GET('/v1/attachments/{id}', { params: { path: { id: lying.id } } })).response.status, 404, 'with no attachment left to download');
});
