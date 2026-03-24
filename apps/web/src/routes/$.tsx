import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Cloud404Layer } from '@/components/three/CloudBackground';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/$')({
  head: () => ({
    meta: [{ title: 'Page Not Found | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.notFound),
  }),
  component: NotFoundPage,
});

function NotFoundPage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className="not-found-page">
      <div
        id="page-content"
        className={isVisible ? 'is-visible' : ''}
        style={{ display: isVisible ? undefined : 'none' }}
      >
        <div className="blobs-container">
          <div className="blob" />
          <div className="blob" />
          <div className="blob" />
          <div className="blob" />
          <div className="blob" />
        </div>
        <main className="content-above-clouds text-center max-w-xl w-full px-4 sm:px-6">
          <div
            id="canvas-404-root"
            className="fade-up"
            style={{ animationDelay: '0.1s', position: 'relative', zIndex: 2 }}
            aria-hidden="true"
          >
            <Cloud404Layer />
          </div>
          <h1
            className="text-2xl sm:text-3xl text-white mb-4 fade-up"
            style={{ animationDelay: '0.2s' }}
          >
            Page not found
          </h1>
          <p
            className="text-base sm:text-lg text-white/80 leading-relaxed fade-up"
            style={{ animationDelay: '0.3s' }}
          >
            The page you&rsquo;re looking for doesn&rsquo;t exist or has been moved.
          </p>
        </main>
      </div>
    </div>
  );
}
