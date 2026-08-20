name: Sync Pipeline Dates

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run date sync
        env:
          MONDAY_TOKEN: ${{ secrets.MONDAY_TOKEN }}
        run: node sync.js
