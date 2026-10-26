import { useState } from 'react';
import { useApp } from './state';
import { DeleteAudioButton } from './ui';
import { AudioTranscript } from './Ai';

export function SavedAudio({ mediaId, canDelete = false, transcript = false, onDeleted }: {
 mediaId: string; canDelete?: boolean; transcript?: boolean; onDeleted?: () => void;
}) {
 const { mutate } = useApp();
 const [deleted, setDeleted] = useState(false);
 if (deleted) return <p className="small muted">Голосовая запись удалена.</p>;
 return <div className="audio-result">
  <audio controls preload="none" src={`/api/media/${mediaId}`}/>
  {transcript && <AudioTranscript mediaId={mediaId}/>}
  {canDelete && <DeleteAudioButton saved onDelete={async () => {
   await mutate(`/media/${mediaId}`, 'DELETE', { confirm: true });
   setDeleted(true); onDeleted?.();
  }}/>}
 </div>;
}
