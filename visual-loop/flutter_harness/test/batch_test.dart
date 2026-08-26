// 批量 golden 渲染: 读 BATCH_MANIFEST(json 数组), 每项渲染一份 golden + 文本块清单
// 条目: {name, spec, golden, manifest} (golden 相对 test/)
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visual_harness/blueprint_view.dart';

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
  final manifestPath = Platform.environment['BATCH_MANIFEST']!;
  final entries = (jsonDecode(File(manifestPath).readAsStringSync()) as List).cast<Map>();
  for (final e in entries) {
    testWidgets('golden ${e['name']}', (tester) async {
      await _loadHarnessFont();
      final spec = jsonDecode(File(e['spec'] as String).readAsStringSync()) as Map<String, dynamic>;
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
      await tester.pumpAndSettle(const Duration(milliseconds: 120));

      final ro = tester.renderObject<RenderBox>(find.byType(BlueprintView));
      final manifest = collectTextBlocks(ro);
      final manifestOut = e['manifest'] as String?;
      if (manifestOut != null) File(manifestOut).writeAsStringSync(manifest);

      await expectLater(find.byType(BlueprintView), matchesGoldenFile(e['golden'] as String));
    });
  }
}
