import readline from 'node:readline';

/**
 * Plain readline, used the normal way -- one shared `rl` for the whole session, every prompt going
 * through the same `rl.question()`. A previous version of this file hand-rolled raw-mode byte
 * reading as a *second*, separate consumer of stdin for masked prompts, switching between it and
 * readline's own line-mode reads with `rl.pause()`/`resume()` per call. That was a real, not just
 * cosmetic, bug: on a real terminal at normal typing speed, values landed in the wrong field
 * entirely (an organization name ending up as the literal password just typed). Masking below works
 * by intercepting readline's own output instead of fighting it for the input -- there is exactly one
 * thing ever reading stdin: readline itself.
 */

type MutableInterface = readline.Interface & {
    _writeToOutput?: (str: string) => void;
    stdoutMuted?: boolean;
};

export function question(rl: readline.Interface, query: string): Promise<string> {
    return new Promise((resolve) => rl.question(query, resolve));
}

/**
 * The standard Node recipe for a masked prompt with no extra dependency: override the interface's
 * own (private, but long-stable) `_writeToOutput` so every keystroke's echo becomes "*" instead of
 * the real character, while the newline on Enter still passes through untouched. Falls back to a
 * plain, visible question if `_writeToOutput` isn't present (older/newer Node internals, or a
 * non-terminal `rl` where it may never even be called) rather than failing outright -- masking is a
 * nicety, capturing the right value is the part that has to work unconditionally.
 */
export function questionHidden(rl: readline.Interface, query: string): Promise<string> {
    const mutable = rl as MutableInterface;
    const original = mutable._writeToOutput;

    if (original === undefined) {
        return question(rl, query);
    }

    return new Promise((resolve) => {
        mutable._writeToOutput = (str: string) => {
            if (mutable.stdoutMuted && str !== '\r\n' && str !== '\n') {
                original.call(rl, '*');
            } else {
                original.call(rl, str);
            }
        };

        rl.question(query, (answer) => {
            mutable._writeToOutput = original;
            mutable.stdoutMuted = false;
            resolve(answer);
        });
        mutable.stdoutMuted = true;
    });
}
