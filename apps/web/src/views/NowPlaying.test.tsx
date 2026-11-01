import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PlayerBar } from '../layout/PlayerBar';
import { tracks } from '../test/fixtures';
import { renderWithApp, setupPlayer } from '../test/render';
import { NowPlayingView } from './NowPlaying';

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function start(n = 3, startIndex = 0) {
  const ctx = setupPlayer();
  renderWithApp(<NowPlayingView />, { api: ctx.api, player: ctx.player, route: '/now-playing' });
  act(() => ctx.player.playTracks(tracks(...Array.from({ length: n }, (_, i) => i + 1)), startIndex));
  await settle();
  act(() => ctx.engine.emit({ type: 'playing' }));
  return ctx;
}

describe('Now Playing (player UI)', () => {
  it('shows the current track and moves through the queue', async () => {
    const user = userEvent.setup();
    const { engine } = await start(3);
    expect(screen.getByRole('heading', { level: 2, name: 'Track 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next track' }));
    await settle();
    expect(screen.getByRole('heading', { level: 2, name: 'Track 2' })).toBeInTheDocument();
    expect(engine.lastLoad()).toContain('/stream/2?');

    const upNext = screen.getByRole('list', { name: '' });
    expect(within(upNext).getAllByRole('listitem')).toHaveLength(1);
  });

  it('toggles play/pause from the big button', async () => {
    const user = userEvent.setup();
    const { engine } = await start(1);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(engine.calls.at(-1)).toBe('pause');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(engine.calls.at(-1)).toBe('play');
  });

  it('exposes shuffle and repeat state to assistive tech', async () => {
    const user = userEvent.setup();
    await start(5);
    const shuffle = screen.getByRole('button', { name: 'Shuffle' });
    expect(shuffle).toHaveAttribute('aria-pressed', 'false');
    await user.click(shuffle);
    expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Track 1' })).toBeInTheDocument(); // current kept

    await user.click(screen.getByRole('button', { name: 'Repeat: off' }));
    await user.click(screen.getByRole('button', { name: 'Repeat: all' }));
    expect(screen.getByRole('button', { name: 'Repeat: one track' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Repeat: one track' }));
    expect(screen.getByRole('button', { name: 'Repeat: off' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('removes and jumps within "Up next"', async () => {
    const user = userEvent.setup();
    const { engine } = await start(4);
    await user.click(screen.getByRole('button', { name: 'Remove Track 3 from the queue' }));
    expect(screen.queryByRole('button', { name: /^Play\s*Track 3\s*by\s*Artist/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Play\s*Track 4\s*by\s*Artist/ }));
    await settle();
    expect(screen.getByRole('heading', { level: 2, name: 'Track 4' })).toBeInTheDocument();
    expect(engine.lastLoad()).toContain('/stream/4?');
  });

  it('refreshes an expired link mid-track and keeps playing from the same position', async () => {
    const { engine, fetchLinks } = await start(2);
    act(() => engine.tick(95));
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('95');
    act(() => engine.emit({ type: 'error', message: 'network' }));
    await settle();
    expect(fetchLinks).toHaveBeenCalledTimes(2);
    expect(engine.lastLoad()).toBe('load http://srv/api/stream/1?v=2 @95 autoplay');
    act(() => engine.emit({ type: 'playing' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Track 1' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveValue('95');
  });

  it('shows an error with a retry when a track keeps failing, and retry fetches a fresh link', async () => {
    const user = userEvent.setup();
    const { engine } = await start(1);
    for (let i = 0; i < 3; i++) {
      act(() => engine.emit({ type: 'error', message: 'x' }));
      await settle();
    }
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't play this track.");
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(engine.lastLoad()).toMatch(/\?v=\d+ @0 autoplay$/);
  });

  it('describes the seek position in words', async () => {
    const { engine } = await start(1);
    act(() => engine.tick(65, 180));
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuetext', '1 minute 5 seconds of 3 minutes 0 seconds');
  });
});

describe('PlayerBar', () => {
  it('shows the current track with play/pause and next', async () => {
    const user = userEvent.setup();
    const ctx = setupPlayer();
    renderWithApp(<PlayerBar />, { api: ctx.api, player: ctx.player, route: '/' });
    expect(screen.queryByRole('region', { name: 'Player' })).not.toBeInTheDocument();
    act(() => ctx.player.playTracks(tracks(1, 2), 0));
    await settle();
    // (jsdom drops the spaces inside visually-hidden spans; browsers keep them)
    expect(screen.getByRole('link', { name: /Now playing:\s*Track 1\s*by\s*Artist\.\s*Open player\./ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(screen.getByRole('link', { name: /Track 2/ })).toBeInTheDocument());
  });
});
