# One Playwright project of the web client's browser specs against the real stack: what CI runs for Firefox and WebKit (the job `e2e-web-browsers`), and what to run to
# reproduce a failure of one of them: `make test-web-e2e-browser BROWSER=firefox` (or `webkit`; `chromium` is `make test-web-e2e`). The steps are those of `test-web-e2e` in
# the Makefile, with the project of the run taken from BROWSER, so that the Makefile itself does not change. Needs the browser once:
# `bunx playwright install --with-deps firefox webkit`.
BROWSER ?= chromium
test-web-e2e-browser: dev-secret
	@case "$(BROWSER)" in chromium|firefox|webkit) ;; *) echo "BROWSER must be chromium, firefox or webkit, not '$(BROWSER)'" >&2; exit 2;; esac
	bun install --frozen-lockfile
	bun run build
	cd apps/web && bunx vite build --mode e2e
	GRIMOIRE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:8333 $(WEB_COMPOSE) $(MAKE) up
	GRIMOIRE_ALLOWED_ORIGINS="http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:$${E2E_WEB_PORT:-4173},http://localhost:$${E2E_WEB_PORT:-4173}" $(MAKE) files-setup
	E2E_DEV_TOKEN_SECRET="$$(sed -n 's/^GRIMOIRE_DEV_TOKEN_SECRET=//p' .env)" bunx playwright test -c apps/web/playwright.config.ts --project=$(BROWSER)

.PHONY: test-web-e2e-browser
