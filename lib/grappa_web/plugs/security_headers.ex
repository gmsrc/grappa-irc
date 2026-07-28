defmodule GrappaWeb.Plugs.SecurityHeaders do
  @moduledoc """
  Emit the security-header set (CSP + four siblings) on EVERY response.

  ## Single source of truth (#485)

  These headers used to live only in `infra/snippets/security-headers.conf`,
  included by the nginx container that fronted the BEAM. #485 dropped that
  container and made the BEAM self-serve the SPA, so the headers moved here —
  where they belong. This plug is now the SOLE owner on every substrate:

    * Docker `--profile prod` — one container, BEAM published directly;
    * the m42 bastille jail — the in-jail nginx is a dumb reverse proxy that
      emits none of these (it would otherwise double the CSP, and duplicate
      `Content-Security-Policy` headers are enforced as the *intersection*,
      not the union — a prod-only footgun this centralisation removes);
    * an operator's own TLS front door — which previously got NO security
      headers at all, because ours only existed in a container they were
      told to bypass.

  Placed BEFORE `:serve_cic_static` in the endpoint and implemented via
  `register_before_send/2` so the headers land on `Plug.Static` hits (which
  send + halt) and on error responses alike — the app-side equivalent of
  nginx's `add_header ... always`. Registered early, so its callback runs
  LAST (before_send is LIFO) and its value wins over anything downstream set.

  ## CSP allowlist (hard-won — do not rewrite casually)

  RULE (2026-06-10, learned in prod): declaring ANY fetch directive REPLACES
  the `default-src` fallback for that resource type — it does not extend it.
  Every directive must restate `'self'` (and every other source `default-src`
  was silently providing) unless its absence is deliberate AND commented. The
  bare `media-src blob:` first cut cost a prod-only dogfood debugging session;
  e2e ships green on this mistake class because the test stack's CSP coverage
  historically lagged (that gap closes with #485 — the e2e nginx now proxies
  to the BEAM, so these plug-emitted headers are exercised end-to-end).

    * `default-src 'self'` — same-origin baseline.
    * `connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com
      https://litterbox.catbox.moe` — REST + WS to grappa (same-origin: `'self'`
      covers `ws://$host` / `wss://$host` per CSP3, so this is deployment-host
      agnostic — no edit when `PHX_HOST` changes); Cloudflare Turnstile +
      hCaptcha verification XHRs; `litterbox.catbox.moe` receives cic's
      image-upload XHR. The response host `litter.catbox.moe` needs NO `img-src`
      entry — cic never renders the image; the user clicks the link and the
      browser opens it as its own document load outside our CSP. IRC stays
      text only (CLAUDE.md).
    * `script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='
      https://challenges.cloudflare.com https://*.hcaptcha.com` — Vite modules +
      the Turnstile / hCaptcha widget loaders. Each loader injects a small
      INLINE bootstrap `<script>` that `script-src` blocks unless allowlisted;
      we pin it by sha256 (CSP3 hash-source) rather than relax to
      `'unsafe-inline'`, keeping our own first-party inline scripts forbidden.
      CAVEAT: the hash is the provider's inline bootstrap content — a
      provider-side widget update changes the bytes → new hash → the captcha
      silently fails CSP. When that happens the browser console prints the new
      `sha256-…` to add here (do NOT switch to `'unsafe-inline'`).
    * `style-src 'self' 'unsafe-inline' https://*.hcaptcha.com` — SolidJS ships
      dynamic style tags during interactive renders; rejecting `'unsafe-inline'`
      would break the irssi-shape theme system. hCaptcha loads its own sheet
      from `assets.hcaptcha.com`.
    * `img-src 'self' data:` — favicons + manifest icons + SolidJS inline `data:` SVGs.
    * `font-src 'self'` — system fonts only.
    * `manifest-src 'self'` — PWA install manifest.
    * `media-src 'self' blob:` — `blob:` for the video-upload duration probe
      (off-DOM `<video>` via `URL.createObjectURL`, videoPolicy.ts); `'self'`
      because declaring `media-src` REPLACES the `default-src` fallback and
      direct navigation to `/uploads/<slug>` videos (the 🎬 link — browsers
      render mp4 in a media document governed by this header) needs it.
    * `worker-src 'self' blob:` — the SW shell-cache worker, plus mediabunny
      spawns codec workers from `blob:` URLs.
    * `frame-src https://challenges.cloudflare.com https://*.hcaptcha.com` —
      Turnstile + hCaptcha render the challenge in a provider-hosted iframe.
      DELIBERATELY no `'self'` (the one RULE exception): cic never self-frames,
      and `frame-ancestors 'none'` + `X-Frame-Options DENY` would kill a
      same-origin iframe anyway.
    * `frame-ancestors 'none'` — no embedding (clickjacking).
    * `base-uri 'self'` — block `<base>` URL injection.
    * `form-action 'self'` — block form-jacking.

  `X-Content-Type-Options: nosniff` stops MIME-sniffing; `Referrer-Policy:
  same-origin` avoids leaking the canonical host on outbound clicks;
  `Permissions-Policy` disables device APIs the bouncer never asks for.
  CSP is the realistic XSS mitigation for the bearer-in-localStorage design
  (see cic `auth.ts`) — this is where it lands on the wire.
  """
  @behaviour Plug

  import Plug.Conn

  @csp "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe; script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=' https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com; img-src 'self' data:; font-src 'self'; manifest-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

  # HTTP header names are lower-cased (HTTP/2 + Plug convention); the VALUES
  # are byte-identical to the retired nginx snippet.
  @headers [
    {"content-security-policy", @csp},
    {"x-content-type-options", "nosniff"},
    {"referrer-policy", "same-origin"},
    {"x-frame-options", "DENY"},
    {"permissions-policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()"}
  ]

  @doc """
  The Content-Security-Policy string this plug emits. Exposed so callers and
  tests reference the SSOT instead of re-typing the (long, fragile) literal.
  """
  @spec csp() :: String.t()
  def csp, do: @csp

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts), do: register_before_send(conn, &put_security_headers/1)

  defp put_security_headers(conn) do
    Enum.reduce(@headers, conn, fn {name, value}, acc ->
      put_resp_header(acc, name, value)
    end)
  end
end
