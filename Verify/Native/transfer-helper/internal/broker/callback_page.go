package broker

import (
	"html"
	"strings"
)

const callbackPageTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>__TITLE__</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <svg style="display:none" aria-hidden="true">
    <filter id="liq-sm" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves="3" seed="7" result="noise" />
      <feGaussianBlur in="noise" stdDeviation="2.5" result="smooth" />
      <feDisplacementMap in="SourceGraphic" in2="smooth" scale="6" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </svg>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: 'DM Sans', 'Segoe UI', system-ui, sans-serif;
      color: rgba(255,255,255,0.92);
      background: #779dc3;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow-x: hidden;
    }
    .sky {
      position: fixed;
      inset: -8%;
      pointer-events: none;
      z-index: 0;
    }
    .sky::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 20% 54%, rgba(255,255,255,0.42) 0, rgba(255,255,255,0.42) 10%, rgba(255,255,255,0.18) 16%, transparent 24%),
        radial-gradient(circle at 76% 28%, rgba(255,255,255,0.34) 0, rgba(255,255,255,0.34) 8%, rgba(255,255,255,0.12) 14%, transparent 21%),
        radial-gradient(circle at 48% 78%, rgba(255,255,255,0.28) 0, rgba(255,255,255,0.28) 12%, rgba(255,255,255,0.10) 18%, transparent 26%);
      filter: blur(28px);
      opacity: 0.95;
    }
    .sky::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse 32% 20% at 14% 48%, rgba(255,255,255,0.55) 0%, transparent 100%),
        radial-gradient(ellipse 22% 14% at 74% 26%, rgba(255,255,255,0.50) 0%, transparent 100%),
        radial-gradient(ellipse 44% 24% at 46% 70%, rgba(255,255,255,0.45) 0%, transparent 100%);
      filter: blur(20px);
      opacity: 0.55;
    }
    .shell {
      position: relative;
      z-index: 1;
      width: min(380px, 100%);
      animation: fadein 0.5s cubic-bezier(0.22,1,0.36,1) both;
    }
    @keyframes fadein {
      from { opacity: 0; transform: translateY(14px) scale(0.984); }
      to { opacity: 1; transform: none; }
    }
    .card {
      position: relative;
      background: rgba(0,0,0,0.28);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      border: 1px solid rgba(255,255,255,0.13);
      box-shadow:
        0 24px 64px rgba(0,0,0,0.45),
        inset 0 1px 0 rgba(255,255,255,0.10),
        inset 0 -1px 0 rgba(0,0,0,0.15);
      border-radius: 28px;
      padding: 40px 36px 32px;
      overflow: hidden;
      text-align: center;
    }
    .card::before {
      content: "";
      position: absolute;
      top: 0; left: 50%;
      transform: translateX(-50%);
      width: 55%; height: 1px;
      background: linear-gradient(90deg, transparent, __ACCENT_START__, transparent);
      opacity: 0.6;
      pointer-events: none;
    }
    .card::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 14%, transparent 34%),
        radial-gradient(circle at 22% 0%, rgba(255,255,255,0.14), transparent 34%);
      filter: url(#liq-sm);
      opacity: 0.9;
    }
    h1 {
      font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: #fff;
      line-height: 1.12;
      margin: 0 0 8px;
    }
    .body-copy {
      font-size: 13px;
      line-height: 1.65;
      color: rgba(255,255,255,0.5);
      margin: 0 0 20px;
    }
    .divider {
      width: 100%; height: 1px;
      background: rgba(255,255,255,0.07);
      margin: 0 0 18px;
    }
    .detail-card {
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      padding: 14px 16px;
    }
    .detail-card-success {
      background: rgba(54,191,177,0.07);
      border-color: rgba(54,191,177,0.22);
    }
    .detail-card-error {
      background: rgba(239,68,68,0.07);
      border-color: rgba(239,68,68,0.22);
    }
    .detail-label {
      display: block;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.32);
      margin-bottom: 7px;
      font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
    }
    .detail-body {
      font-size: 13px;
      line-height: 1.6;
      color: rgba(255,255,255,0.78);
      word-break: break-word;
    }
    .logo-wrap {
      display: flex;
      justify-content: center;
      margin-top: 18px;
    }
    .logo-wrap img {
      width: min(220px, 72%);
      height: auto;
      object-fit: contain;
      filter: drop-shadow(0 10px 28px rgba(0,0,0,0.22));
    }
    @media (prefers-reduced-motion: reduce) {
      .shell { animation: none; }
    }
  </style>
</head>
<body>
  <div class="sky"></div>
  <div class="shell">
    <div class="card">
      <h1>__TITLE__</h1>
      <p class="body-copy">__MESSAGE__</p>
      <div class="divider"></div>
      __DETAIL_HTML__
    </div>
    <div class="logo-wrap">
      <img src="https://raw.githubusercontent.com/Yeusepe/YUCP-Creator-Assistant/refs/heads/main/apps/web/public/Icons/MainLogo.png" alt="YUCP" />
    </div>
  </div>
</body>
</html>`

func buildOAuthCallbackPage(
	title string,
	message string,
	detailHTML string,
	accentStart string,
) string {
	return strings.NewReplacer(
		"__TITLE__", html.EscapeString(title),
		"__MESSAGE__", html.EscapeString(message),
		"__DETAIL_HTML__", detailHTML,
		"__ACCENT_START__", accentStart,
	).Replace(callbackPageTemplate)
}

func buildOAuthSuccessPage() string {
	return buildOAuthCallbackPage(
		"Creator Identity is ready",
		"Return to Unity. Your purchase verification controls are now available in the YUCP Package Manager.",
		`<div class="detail-card detail-card-success"><span class="detail-label">Next</span><div class="detail-body">You can close this tab and continue in Unity.</div></div>`,
		"#36bfb1",
	)
}

func buildOAuthErrorPage(detail string) string {
	return buildOAuthCallbackPage(
		"We could not finish the YUCP sign-in",
		"Return to Unity, review the details below, and try again once the server is ready.",
		`<div class="detail-card detail-card-error"><span class="detail-label">Details</span><div class="detail-body">`+
			html.EscapeString(detail)+
			`</div></div>`,
		"#fb7185",
	)
}
