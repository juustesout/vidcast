import {Circle, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {createRef, easeOutCubic, waitFor} from '@motion-canvas/core';

export default makeScene2D(function* (view) {
  const disc = createRef<Circle>();
  const plate = createRef<Rect>();

  view.add(
    <Rect
      ref={plate}
      width={420}
      height={240}
      radius={28}
      fill={'#22c55e'}
      opacity={0}
    />,
  );
  view.add(
    <Circle ref={disc} size={180} fill={'#ef4444'} x={0} y={0} opacity={0} />,
  );
  view.add(
    <Txt
      text={'alpha probe'}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={40}
      fontWeight={700}
      fill={'#0f172a'}
      y={0}
    />,
  );

  yield* plate().opacity(1, 0.35, easeOutCubic);
  yield* disc().opacity(1, 0.35, easeOutCubic);
  yield* waitFor(0.3);
});
