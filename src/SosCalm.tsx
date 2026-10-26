import { useState } from 'react';
import { Icon } from './ui';

export function CalmingCircle() {
 return <span className="sos-calm-circle" aria-hidden="true"><span className="sos-calm-halo"/><span className="sos-calm-core"><Icon name="heart"/></span></span>;
}

export function SosCalm() {
 const [paused, setPaused] = useState(false);
 const pauseLabel = paused ? 'Продолжить анимацию' : 'Приостановить анимацию';

 return <aside className={`sos-calm ${paused ? 'is-paused' : ''}`} aria-label="Поддержка во время SOS">
  <CalmingCircle/>
  <div className="sos-calm-copy"><h2>Один шаг за раз</h2><p>Можно отвечать коротко, своими словами.</p></div>
  <button type="button" className="icon-button sos-calm-toggle" aria-label={pauseLabel} title={pauseLabel} onClick={() => setPaused(value => !value)}><Icon name={paused ? 'play' : 'pause'}/></button>
 </aside>;
}
