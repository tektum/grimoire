import type { Directory } from '../../editor/core/directory';
import type { Session } from '../../editor/core/connection';
import { createLiveSession, type LiveSession } from '../../editor/core/real-provider';
import { mountLive, mountReadOnly, type MountedEditor } from '../../editor/core/mount';

export interface Presence {
  userId: () => string | null;
  directory: Directory;
}

/** What the page screen builds the editor and the connection from. A test hands in fakes: a real editor needs a browser. */
export interface Engine {
  createSession(options: { url: string; pageId: string; token: () => Promise<string> }): Session;
  mountReadOnly(element: HTMLElement, markdown: string): Promise<MountedEditor>;
  mountLive(options: { element: HTMLElement; session: Session; editable: boolean; isCancelled: () => boolean; presence: Presence }): Promise<MountedEditor | null>;
}

export const realEngine: Engine = {
  createSession: createLiveSession,
  mountReadOnly,
  mountLive: ({ element, session, editable, isCancelled, presence }) => {
    const live = session as LiveSession;
    return mountLive({ element, doc: live.ydoc, awareness: live.awareness, editable, isCancelled, presence });
  },
};
