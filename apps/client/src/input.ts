import type { PodInput } from '@digger/shared';

const MAP: Record<string, keyof PodInput> = {
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
};

export interface KeyActions {
  toggleShop(): void;
  closeShop(): void;
  toggleDebug(): void;
  buyIndex(i: number): void;
  radar(): void;
}

export class Keyboard {
  readonly state: PodInput = { left: false, right: false, up: false, down: false };
  enabled = true;

  constructor(private readonly actions: KeyActions) {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.clear);
  }

  private clear = (): void => {
    this.state.left = this.state.right = this.state.up = this.state.down = false;
  };

  private onDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement) return;
    const dir = MAP[e.code];
    if (dir !== undefined) {
      this.state[dir] = true;
      e.preventDefault();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); this.actions.radar(); return; }
    if (e.code === 'KeyB') this.actions.toggleShop();
    else if (e.code === 'Escape') this.actions.closeShop();
    else if (e.code === 'F3') { e.preventDefault(); this.actions.toggleDebug(); }
    else if (e.code.startsWith('Digit')) this.actions.buyIndex(Number(e.code.slice(5)) - 1);
  };

  private onUp = (e: KeyboardEvent): void => {
    const dir = MAP[e.code];
    if (dir !== undefined) this.state[dir] = false;
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.clear);
    this.clear();
  }
}
