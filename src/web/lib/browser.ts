/** Leaving the app for another site, behind an object so a test can stand in for jsdom's unimplemented navigation. */
export const browser = {
  leaveFor(url: string) {
    window.location.assign(url);
  },
};
