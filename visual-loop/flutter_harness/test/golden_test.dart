// golden 渲染入口: 读环境变量指定的 spec, 离屏渲染并输出 golden PNG + 文本块清单
//
// 环境变量:
//   BLUEPRINT_SPEC  spec json 路径 (mode=truth|flex)
//   GOLDEN_OUT      golden png 输出路径(相对 test/)
//   MANIFEST_OUT    文本块清单 json 输出路径
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visual_harness/blueprint_view.dart';

Future<void> _loadHarnessFont() async {
  // 从系统路径加载真实 CJK 字体, 避免 flutter_test 默认 Ahem 方块字
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
  testWidgets('blueprint golden', (tester) async {
    await _loadHarnessFont();
    final specPath = Platform.environment['BLUEPRINT_SPEC']!;
    final spec = jsonDecode(File(specPath).readAsStringSync()) as Map<String, dynamic>;
    final width = (spec['width'] as num).toDouble();
    final height = (spec['height'] as num).toDouble();

    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = Size(width, height);
    addTearDown(tester.view.reset);

    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      home: MediaQuery(
        data: MediaQueryData(size: Size(width, height)),
        child: SingleChildScrollView(child: BlueprintView(spec: spec)),
      ),
    ));
    await tester.pumpAndSettle(const Duration(milliseconds: 200));

    // 导出真实渲染的文本块清单
    final ro = tester.renderObject<RenderBox>(find.byType(BlueprintView));
    final manifest = collectTextBlocks(ro);
    final manifestOut = Platform.environment['MANIFEST_OUT'];
    if (manifestOut != null) File(manifestOut).writeAsStringSync(manifest);

    await expectLater(
      find.byType(BlueprintView),
      matchesGoldenFile(Platform.environment['GOLDEN_OUT']!),
    );
  });
}
