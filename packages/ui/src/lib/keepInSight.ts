/**
 * Scrolls the list a row is in, and only that list, so the row is wholly in
 * sight with a little room around it. Not `scrollIntoView`, which also moves
 * every scroller around the list, such as whatever holds a closed phone drawer.
 */
export function keepInSight(row: HTMLElement, list: string, room = 8) {
  const scroller = row.closest<HTMLElement>(list);
  if (!scroller || scroller.clientHeight === 0) return;
  const top =
    row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const bottom = top + row.offsetHeight;
  if (top - room < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - room);
  else if (bottom + room > scroller.scrollTop + scroller.clientHeight)
    scroller.scrollTop = bottom + room - scroller.clientHeight;
}
