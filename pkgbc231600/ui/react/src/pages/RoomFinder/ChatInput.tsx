/**
 * The ask box: a free-text question, a submit button, and one-tap examples.
 *
 * Deliberately a textarea and not a single-line input. The model does better
 * with "I'm on floor 2 near 2210 and I'm late for class in 2080" than with a
 * room number, so the control has to look like somewhere you write a sentence.
 * Enter still submits — Shift+Enter is the newline — because the common case is
 * one line and nobody should have to reach for the mouse.
 *
 * The examples are not decoration. A vision wayfinder is unusual enough that
 * most people's first instinct is to type a bare room number, which wastes the
 * interesting half of the feature; a chip shows the shape of a good question in
 * one tap. They come from `BuildingFacts#demoRoutes`, so they are the same
 * sentences the backend has pinned answers for.
 */

import React from 'react';
import { CornerDownLeft, Search, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChatInputProps {
  /** Fired with the trimmed question. Never called with an empty string. */
  onSubmit: (message: string) => void;
  /** True while a route is being generated; disables the form and spins the button. */
  loading: boolean;
  /** Example questions to offer as chips. */
  examples: string[];
  /**
   * Blocks submission entirely — used when the building is not set up, where a
   * request could only fail.
   */
  disabled?: boolean;
}

export default function ChatInput({ onSubmit, loading, examples, disabled = false }: ChatInputProps) {
  const [message, setMessage] = React.useState('');

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && !loading && !disabled;

  const submit = React.useCallback(() => {
    // `message` is declared `!string` on the backend, so the platform rejects a
    // blank one before the method body runs. Guarding here keeps that from ever
    // surfacing as an opaque Err.InvalidCall.
    if (!canSubmit) return;
    onSubmit(trimmed);
  }, [canSubmit, onSubmit, trimmed]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleExample = (example: string) => {
    setMessage(example);
    if (!loading && !disabled) onSubmit(example);
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="room-finder-question"
        className="text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]"
      >
        Where are you, and where do you need to be?
      </label>

      <Textarea
        id="room-finder-question"
        value={message}
        rows={3}
        disabled={loading || disabled}
        placeholder="e.g. I'm on floor 2 near 2210 and I'm late for class in 2080"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="solid"
          appearance="accent"
          size="md"
          loading={loading}
          disabled={!canSubmit}
          leadingIcon={<Search />}
          onClick={submit}
        >
          {loading ? 'Finding the way…' : 'Find my way'}
        </Button>
        <span className="flex items-center gap-1 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
          <CornerDownLeft className="size-3" aria-hidden />
          Enter to send
        </span>
      </div>

      {examples.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]">
            <Sparkles className="size-3.5" aria-hidden />
            Try one of these
          </span>
          <div className="flex flex-col gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                disabled={loading || disabled}
                onClick={() => handleExample(example)}
                className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] px-2.5 py-1.5 text-left text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)] hover:border-[var(--c3-style-accent-border-strong)] hover:text-[var(--c3-style-basic-fg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
