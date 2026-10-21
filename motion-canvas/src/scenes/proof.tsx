import {Circle, Line, Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {
  all,
  createRef,
  createRefArray,
  easeInOutCubic,
  easeOutBack,
  easeOutBounce,
  linear,
  range,
  sequence,
  spawn,
  waitFor,
} from '@motion-canvas/core';

export default makeScene2D(function* (view) {
  const title = createRef<Txt>();
  const bars = createRefArray<Rect>();
  const mascot = createRef<Node>();
  const values = [0.38, 0.64, 0.52, 0.88, 0.71];
  const colors = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f472b6'];
  const barWidth = 92;
  const gap = 30;
  const maxHeight = 430;
  const chartLeft = -620;
  const chartBase = 220;

  view.add(
    <Txt
      ref={title}
      text={'P102.1 Motion Canvas Proof'}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={68}
      fontWeight={700}
      fill={'#f8fafc'}
      y={-470}
      opacity={0}
    />,
  );
  view.add(
    <Line
      points={[
        [chartLeft - 40, chartBase],
        [chartLeft + 5 * (barWidth + gap) + 10, chartBase],
      ]}
      stroke={'#64748b'}
      lineWidth={6}
      lineCap={'round'}
    />,
  );
  view.add(
    <Node>
      {range(5).map(index => (
        <Rect
          ref={bars}
          x={chartLeft + index * (barWidth + gap) + barWidth / 2}
          y={chartBase}
          width={barWidth}
          height={0}
          radius={[18, 18, 8, 8]}
          offsetY={1}
          fill={colors[index]}
        />
      ))}
    </Node>,
  );
  view.add(
    <Node ref={mascot} x={520} y={-40}>
      <Rect y={118} width={96} height={118} radius={30} fill={'#f59e0b'} />
      <Circle y={12} size={128} fill={'#fde68a'} />
      <Circle x={-24} y={2} size={18} fill={'#0f172a'} />
      <Circle x={24} y={2} size={18} fill={'#0f172a'} />
      <Circle
        y={28}
        width={54}
        height={32}
        fill={'#ea580c'}
        startAngle={12}
        endAngle={168}
        closed
      />
      <Rect y={210} x={-22} width={28} height={54} radius={12} fill={'#f59e0b'} />
      <Rect y={210} x={22} width={28} height={54} radius={12} fill={'#f59e0b'} />
    </Node>,
  );
  view.add(
    <Txt
      text={'chart build'}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={28}
      fill={'#94a3b8'}
      x={chartLeft + 2 * (barWidth + gap) + barWidth / 2}
      y={chartBase + 48}
    />,
  );

  spawn(function* () {
    for (const _ of range(4)) {
      yield* mascot().y(210, 0.45, easeInOutCubic);
      yield* mascot().y(-40, 0.65, easeOutBounce);
    }
  });

  yield* title().opacity(1, 0.5, easeOutBack);
  yield* sequence(
    0.15,
    ...bars.map((bar, index) =>
      bar.height(values[index] * maxHeight, 0.7, easeOutBack),
    ),
  );
  yield* all(
    title().scale(1.06, 0.4, easeInOutCubic).to(1, 0.4, easeInOutCubic),
    mascot().rotation(8, 0.25, linear).to(-8, 0.3, linear).to(0, 0.25, linear),
  );
  yield* waitFor(2.4);
});
