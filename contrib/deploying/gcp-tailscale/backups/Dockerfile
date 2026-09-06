FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --chown=65532:65532 runner.py /app/runner.py
USER 65532:65532
RUN python3 -c "import runpy; runpy.run_path('/app/runner.py', run_name='build_check')"
CMD ["python3", "/app/runner.py"]
