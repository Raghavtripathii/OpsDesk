import type { ConflictInfo } from '../api/queries';

interface Props {
  conflict: ConflictInfo;
  onDismiss: () => void;
}

// Shown after a 409: the screen already holds the server's latest copy,
// so the person only has to look at it and try their change again.
export function ConflictBanner({ conflict, onDismiss }: Props) {
  return (
    <div className="banner banner-warn" role="alert">
      <div>
        <strong>Someone else changed this item first.</strong>
        <p>
          Your change was not saved (you had version {conflict.yourVersion}, the latest is {conflict.currentVersion}).
          We loaded the latest details below. Review them and try again.
        </p>
      </div>
      <button className="btn btn-small" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}