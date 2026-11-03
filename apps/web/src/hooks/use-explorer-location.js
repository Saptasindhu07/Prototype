import { useEffect, useState } from 'react';
import { explorerSearch, nextExplorerLocation, readExplorerLocation } from '../services/explorer-state';

function readLocation() {
  return readExplorerLocation(window.location.search);
}

export function useExplorerLocation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const handleBack = () => setLocation(readLocation());
    window.addEventListener('popstate', handleBack);
    return () => window.removeEventListener('popstate', handleBack);
  }, []);
  function navigate(patch) {
    const params = explorerSearch(nextExplorerLocation(location, patch));
    window.history.pushState(null, '', `${window.location.pathname}${params ? `?${params}` : ''}`);
    setLocation(readLocation());
  }
  return [location, navigate];
}
