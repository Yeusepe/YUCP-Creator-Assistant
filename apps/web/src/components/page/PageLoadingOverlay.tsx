const BAG_PATH =
  'M10.4532 65.9999C3.56938 65.9999 0 62.4297 0 55.5789V22.2894C0 15.4064 3.56938 11.8684' +
  ' 10.4532 11.8684H15.6479C16.3172 5.08187 21.7031 0 28.7781 0C35.885 0 41.271 5.0497' +
  ' 41.9084 11.8684H47.135C53.9869 11.8684 57.5882 15.4386 57.5882 22.2894V55.5789C57.5882' +
  ' 62.4297 54.0188 65.9999 47.9317 65.9999H10.4532ZM28.7781 5.62865C25.0176 5.62865 22.2768' +
  ' 8.13742 21.735 11.8684H35.8532C35.3114 8.13742 32.5706 5.62865 28.7781 5.62865Z';

export function PageLoadingOverlay() {
  return (
    <div id="page-loading-overlay">
      <div className="plo-bag-scene">
        <svg
          className="plo-bag-outline"
          viewBox="0 0 58 66"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          overflow="visible"
        >
          <path d={BAG_PATH} fill="none" stroke="white" strokeWidth="10" />
        </svg>
        <div className="plo-bag-color">
          <div className="plo-blob plo-blob-1" />
          <div className="plo-blob plo-blob-2" />
          <div className="plo-blob plo-blob-3" />
          <div className="plo-blob plo-blob-4" />
          <div className="plo-blob plo-blob-5" />
        </div>
      </div>
      <div className="plo-bar-wrap">
        <div className="plo-bar" />
      </div>
    </div>
  );
}
