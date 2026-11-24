import type { Page, WebSocketRoute } from '@playwright/test';

export interface Network {
  /** The network goes: the browser says offline, the open sockets of the page are closed, and a socket opened meanwhile is closed at once. */
  cut(): Promise<void>;
  /** The network is back: the browser says online and sockets connect again. */
  restore(): Promise<void>;
}

/**
 * Lets a spec take the network away from a page the way a real outage does for the page. The browser's offline mode alone does not: it leaves the sockets that are
 * already open open, so the page is told it is offline but the connection goes on working. Call it before the page opens its socket.
 */
export async function controlNetwork(page: Page): Promise<Network> {
  const open: WebSocketRoute[] = [];
  let down = false;
  await page.routeWebSocket(/.*/, (socket) => {
    if (down) return void socket.close({ code: 4000, reason: 'the network is down' });
    open.push(socket);
    socket.connectToServer();
  });
  return {
    async cut() {
      down = true;
      await page.context().setOffline(true);
      for (const socket of open.splice(0)) await socket.close({ code: 4000, reason: 'the network is down' });
    },
    async restore() {
      down = false;
      await page.context().setOffline(false);
    },
  };
}
