import {Line, Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {
  all,
  createRef,
  createRefArray,
  createSignal,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  linear,
  sequence,
  waitFor,
} from '@motion-canvas/core';

import {readChartParams} from '../template-params';

export default makeScene2D(function* (view) {
  const params = readChartParams();
  const labelsText = params.labels;
  const values = params.values;
  const colors = params.colors;
  const title = createRef<Txt>();
  const subtitle = createRef<Txt>();
  const bars = createRefArray<Rect>();
  const labels = createRefArray<Txt>();
  const trend = createRef<Line>();
  const marker = createRef<Rect>();
  const counts = values.map(() => createSignal(0));
  const barWidth = values.length > 5 ? 120 : 150;
  const gap = values.length > 5 ? 36 : 48;
  const maxHeight = 520;
  const chartLeft = -520;
  const chartBase = 250;
  const chartRight = chartLeft + labelsText.length * (barWidth + gap) - gap;
  const valueMax = Math.max(100, ...values);
  const peakIndex = values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
  const peakValue = values[peakIndex];

  view.add(
    <Rect width={1920} height={1080} fill={params.background} />,
  );
  view.add(
    <Txt
      ref={title}
      text={params.title}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={72}
      fontWeight={700}
      fill={'#f8fafc'}
      y={-430}
      opacity={0}
    />,
  );
  view.add(
    <Txt
      ref={subtitle}
      text={params.subtitle}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={32}
      fill={'#94a3b8'}
      y={-360}
      opacity={0}
    />,
  );
  view.add(
    <Line
      points={[
        [chartLeft - 50, chartBase],
        [chartRight + 50, chartBase],
      ]}
      stroke={'#475569'}
      lineWidth={6}
      lineCap={'round'}
    />,
  );
  view.add(
    <Node>
      {labelsText.map((quarter, index) => (
        <Node>
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
          <Txt
            ref={labels}
            text={() => `${Math.round(counts[index]())}`}
            fontFamily={'DejaVu Sans, Arial, sans-serif'}
            fontSize={36}
            fontWeight={700}
            fill={'#e2e8f0'}
            x={chartLeft + index * (barWidth + gap) + barWidth / 2}
            y={chartBase - 36}
            opacity={0}
          />
          <Txt
            text={quarter}
            fontFamily={'DejaVu Sans, Arial, sans-serif'}
            fontSize={28}
            fill={'#94a3b8'}
            x={chartLeft + index * (barWidth + gap) + barWidth / 2}
            y={chartBase + 48}
          />
        </Node>
      ))}
    </Node>,
  );
  view.add(
    <Line
      ref={trend}
      points={values.map((value, index) => [
        chartLeft + index * (barWidth + gap) + barWidth / 2,
        chartBase - (value / valueMax) * maxHeight,
      ])}
      stroke={'#f8fafc'}
      lineWidth={8}
      lineCap={'round'}
      lineJoin={'round'}
      end={0}
    />,
  );
  view.add(
    <Rect
      ref={marker}
      x={chartLeft + peakIndex * (barWidth + gap) + barWidth / 2}
      y={chartBase - (peakValue / valueMax) * maxHeight - 70}
      width={210}
      height={48}
      radius={12}
      fill={'#fbbf24'}
      opacity={0}
    />,
  );
  view.add(
    <Txt
      text={`peak ${Math.round(peakValue)}`}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={26}
      fontWeight={700}
      fill={'#0f172a'}
      x={chartLeft + peakIndex * (barWidth + gap) + barWidth / 2}
      y={chartBase - (peakValue / valueMax) * maxHeight - 70}
      opacity={() => marker().opacity()}
    />,
  );

  yield* all(
    title().opacity(1, 0.35, easeOutCubic),
    subtitle().opacity(1, 0.35, easeOutCubic),
  );
  yield* sequence(
    0.18,
    ...bars.map((bar, index) =>
      all(
        bar.height((values[index] / valueMax) * maxHeight, 0.7, easeOutBack),
        counts[index](values[index], 0.7, linear),
        labels[index].y(chartBase - (values[index] / valueMax) * maxHeight - 36, 0.7, easeOutBack),
        labels[index].opacity(1, 0.25, easeOutCubic),
      ),
    ),
  );
  yield* trend().end(1, 0.7, easeInOutCubic);
  yield* all(
    marker().opacity(1, 0.25, easeOutCubic),
    bars[peakIndex].scale(1.06, 0.2, easeOutCubic).to(1, 0.25, easeInOutCubic),
  );
  yield* waitFor(params.holdSeconds);
});
