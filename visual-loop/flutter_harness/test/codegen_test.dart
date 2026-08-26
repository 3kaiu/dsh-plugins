// codegen 契约门禁: LLM 手写代码(GeneratedPillButton) vs 确定性真值栅格, 逐像素对比
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visual_harness/generated_pill_button.dart';

Future<void> _loadHarnessFont() async {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  final loader = FontLoader('HarnessCJK');
  for (final p in candidates) {
    final f = File(p);
    if (f.existsSync()) {
      loader.addFont(Future.value(f.readAsBytesSync().buffer.asByteData()));
      break;
    }
  }
  await loader.load();
}

void main() {
  testWidgets('codegen pill golden', (tester) async {
    await _loadHarnessFont();
    final bg = File(Platform.environment['BG_SVG']!).readAsStringSync();

    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(80, 32);
    addTearDown(tester.view.reset);

    // 仿真实运行环境: MaterialApp 提供方向性/主题等环境依赖
    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      home: MediaQuery(
        data: const MediaQueryData(size: Size(80, 32)),
        // 背景与真值栅格一致(背景层排除后页面为暗底), 保证边缘反差公平
        child: Scaffold(
          backgroundColor: Colors.black,
          body: Center(child: GeneratedPillButton(backgroundSvg: bg)),
        ),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 120));

    await expectLater(
      find.byType(GeneratedPillButton),
      matchesGoldenFile(Platform.environment['GOLDEN_OUT']!),
    );
  });
}
