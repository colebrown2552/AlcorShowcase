HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
.PHONY: eval
eval:
	@cd $(HERE); python3 -B eval.py || exit 1; \
	rm -rf out; mkdir -p out; \
	python3 -B fake_server.py & srv=$$!; \
	for i in $$(seq 1 100); do [ -s out/port ] && break; sleep 0.1; done; \
	url="http://127.0.0.1:$$(cat out/port)/v1/chat/completions"; \
	PORTFOLIO_ALCOR_URL="$$url" python3 -B alcor_review.py node --lane fake \
	  --brief fixtures/brief.md --report fixtures/report.md --diff fixtures/diff.patch > out/raw.json; \
	kill $$srv 2>/dev/null; wait $$srv 2>/dev/null; \
	python3 -B -c "import json;d=json.load(open('out/raw.json'));s=d['structured_output'];assert s and 'verdict' in s;json.dump(s,open('out/verdict.json','w'),indent=1)" || exit 1; \
	echo "fixture verdict: out/verdict.json"
