import {Circle, Line, Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {
  all,
  createRef,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  linear,
  spawn,
  waitFor,
} from '@motion-canvas/core';

import {readOverlayParams} from '../template-params';

export default makeScene2D(function* (view) {
  const params = readOverlayParams();
  const root = createRef<Node>();
  const antenna = createRef<Circle>();
  const leftArm = createRef<Rect>();
  const rightArm = createRef<Rect>();
  const leftEye = createRef<Circle>();
  const spark = createRef<Node>();
  const badge = createRef<Rect>();

  view.add(
    <Node ref={root} y={40} scale={0}>
      <Rect y={210} width={70} height={18} radius={9} fill={'#0f172a'} opacity={0.28} />
      <Rect ref={leftArm} x={-78} y={48} width={26} height={92} radius={13} fill={'#155e75'} rotation={18} />
      <Rect ref={rightArm} x={78} y={48} width={26} height={92} radius={13} fill={'#155e75'} rotation={-18} />
      <Rect y={70} width={132} height={150} radius={36} fill={params.bodyColor} />
      <Rect y={78} width={88} height={70} radius={18} fill={'#67e8f9'} opacity={0.35} />
      <Circle y={-48} size={168} fill={params.headColor} />
      <Circle y={-58} size={118} fill={'#ecfeff'} />
      <Circle ref={leftEye} x={-24} y={-62} size={22} fill={'#0f172a'} />
      <Circle x={24} y={-62} size={22} fill={'#0f172a'} />
      <Circle x={-18} y={-68} size={7} fill={'#ffffff'} />
      <Circle x={30} y={-68} size={7} fill={'#ffffff'} />
      <Line
        points={[
          [-22, -28],
          [0, -16],
          [22, -28],
        ]}
        stroke={'#155e75'}
        lineWidth={8}
        lineCap={'round'}
        lineJoin={'round'}
      />
      <Rect x={-28} y={168} width={32} height={58} radius={12} fill={'#164e63'} />
      <Rect x={28} y={168} width={32} height={58} radius={12} fill={'#164e63'} />
      <Rect x={-28} y={198} width={40} height={18} radius={8} fill={'#fb923c'} />
      <Rect x={28} y={198} width={40} height={18} radius={8} fill={'#fb923c'} />
      <Line
        points={[
          [0, -132],
          [0, -188],
        ]}
        stroke={'#155e75'}
        lineWidth={10}
        lineCap={'round'}
      />
      <Circle ref={antenna} y={-208} size={28} fill={'#facc15'} />
      <Rect ref={badge} x={44} y={28} width={72} height={28} radius={8} fill={params.badgeColor} rotation={-8} />
      <Txt
        text={params.badge}
        fontFamily={'DejaVu Sans, Arial, sans-serif'}
        fontSize={18}
        fontWeight={700}
        fill={'#ffffff'}
        x={44}
        y={28}
        rotation={-8}
      />
    </Node>,
  );

  view.add(
    <Node ref={spark} x={160} y={-220} opacity={0}>
      <Line
        points={[
          [0, -28],
          [8, -8],
          [28, 0],
          [8, 8],
          [0, 28],
          [-8, 8],
          [-28, 0],
          [-8, -8],
        ]}
        closed
        fill={'#fde047'}
      />
    </Node>,
  );

  yield* root().scale(1, 0.45, easeOutBack);
  spawn(function* () {
    yield* spark().opacity(1, 0.2, easeOutCubic);
    yield* all(
      spark().rotation(360, 3.2, linear),
      spark().position([-160, -80], 1.6, easeInOutCubic).to([150, 40], 1.6, easeInOutCubic),
    );
    yield* spark().opacity(0, 0.2, easeOutCubic);
  });
  yield* all(
    root().y(-20, 0.35, easeOutCubic).to(40, 0.4, easeInOutCubic),
    antenna().scale(1.35, 0.2, easeOutCubic).to(1, 0.25, easeInOutCubic),
  );
  yield* all(
    leftArm().rotation(-35, 0.28, easeInOutCubic).to(22, 0.28, easeInOutCubic).to(-12, 0.28, easeInOutCubic),
    rightArm().rotation(40, 0.28, easeInOutCubic).to(-20, 0.28, easeInOutCubic).to(16, 0.28, easeInOutCubic),
    badge().scale(1.12, 0.2, easeOutCubic).to(1, 0.3, easeInOutCubic),
  );
  yield* all(
    leftEye().scale(0.12, 0.12, easeInOutCubic).to(1, 0.16, easeOutCubic),
    root().rotation(-6, 0.2, easeInOutCubic).to(6, 0.25, easeInOutCubic).to(0, 0.2, easeInOutCubic),
    antenna().fill('#f97316', 0.2, linear).to('#facc15', 0.25, linear),
  );
  yield* waitFor(1.4);
});
