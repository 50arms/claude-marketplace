/** One argv word written so a POSIX shell reads it back as that one word (an apostrophe becomes the four characters '\''). */
export const shellWord = (word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : "'" + word.split("'").join("'\\''") + "'");
