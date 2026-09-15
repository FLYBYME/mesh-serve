import readline from 'node:readline';

const ENTER_CHARS = new Set(['\n', '\r']);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE_CHARS = new Set(['\b', String.fromCharCode(127)]);

/**
 * One shared async iterator per `rl`, reused across every `question()` call against it.
 *
 * `rl.question()` attaches a one-shot `'line'` listener per call -- fine interactively, where each
 * line only exists once the user presses Enter, but wrong for piped input (scripts, tests): readline
 * drains a buffered chunk and emits every `'line'` event it contains synchronously, before an `await`
 * between two sequential questions gets a chance to attach the second listener. The second line's
 * event fires into nothing, stdin then hits EOF, and the second `question()` never resolves -- caught
 * live running "login" with piped credentials, where the process exited after only reading email.
 * The async iterator queues internally instead of racing a listener against emission, so a line that
 * arrives before anyone asked for it is not lost.
 */
const iterators = new WeakMap<readline.Interface, AsyncIterator<string>>();

function nextLine(rl: readline.Interface): Promise<string> {
    let it = iterators.get(rl);
    if (it === undefined) {
        it = rl[Symbol.asyncIterator]();
        iterators.set(rl, it);
    }
    return it.next().then((result) => result.value ?? '');
}

export function question(rl: readline.Interface, query: string): Promise<string> {
    process.stdout.write(query);
    return nextLine(rl);
}

/**
 * A masked prompt (echoes "*" per keystroke). Node's readline has no built-in hidden-input mode, so
 * this reads raw keypresses directly off stdin -- pausing the shared `rl` interface first so the two
 * don't both try to consume the same stream. Falls back to a plain question when stdin isn't a real
 * TTY (piped input, e.g. scripts or tests): there's no terminal to mask, and an earlier attempt at
 * this via a private readline method (_writeToOutput) silently broke line-reading entirely in that
 * case rather than just skipping the masking.
 */
export function questionHidden(rl: readline.Interface, query: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return question(rl, query);
    }

    return new Promise((resolve) => {
        process.stdout.write(query);
        rl.pause();

        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf-8');

        let value = '';
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.removeListener('data', onData);
            rl.resume();
        };
        const onData = (char: string) => {
            if (ENTER_CHARS.has(char)) {
                cleanup();
                process.stdout.write('\n');
                resolve(value);
            } else if (char === CTRL_D) {
                cleanup();
                process.stdout.write('\n');
                resolve(value);
            } else if (char === CTRL_C) {
                cleanup();
                process.exit(130);
            } else if (BACKSPACE_CHARS.has(char)) {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else {
                value += char;
                process.stdout.write('*');
            }
        };

        stdin.on('data', onData);
    });
}
