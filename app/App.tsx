import { useEffect, useState } from "react";
import Home from "./screens/Home";
import Room from "./screens/Room";

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function App() {
  const path = usePath();
  const roomMatch = path.match(/^\/r\/([a-f0-9]{16})$/);
  if (roomMatch) {
    return <Room roomId={roomMatch[1]} />;
  }
  return <Home />;
}
