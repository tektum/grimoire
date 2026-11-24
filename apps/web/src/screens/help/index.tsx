import { HelpText } from '../../editor/lock';

/** Help on editing together: what the lock protects and the limits of the first version (R3.15, R3.26, R3.27). The same words are on the "Why?" of the lock message. */
export default function HelpScreen() {
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title">Editing together</h1>
      <p>
        While another person&apos;s cursor is in a block, turning that block into a list, a quote or a code block is held back, and the message says who is there. This is what to know about editing at
        the same time:
      </p>
      <HelpText />
    </section>
  );
}
