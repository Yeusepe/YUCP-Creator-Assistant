import { Link } from '@tanstack/react-router';

export function SetupJourneyCard() {
  return (
    <section
      className="intg-card animate-in animate-in-delay-1"
      aria-label="Setup journey overview"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Point.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Server setup</h2>
            <p className="intg-desc">
              Start setup for a new server or review an existing one from one dedicated page. YUCP
              keeps the next step, status, and maintenance tools in one place.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            1. Start
          </p>
          <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
            See the right starting point
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            The setup page tells you whether this server is new, in progress, already set up, or
            needs one fix.
          </p>
        </div>
        <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            2. Connect
          </p>
          <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
            Connect your storefronts
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Start with the providers you sell through so YUCP can pull products and prepare role
            recommendations.
          </p>
        </div>
        <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            3. Review
          </p>
          <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
            Review or update setup
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Finish setup, apply changes, or come back later to review existing mappings and the
            verification message.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          to="/dashboard/setup"
          search={(prev) => prev}
          className="inline-flex items-center rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Open server setup
        </Link>
        <Link
          to="/dashboard"
          search={(prev) => prev}
          className="inline-flex items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
        >
          Back to general settings
        </Link>
      </div>
    </section>
  );
}
