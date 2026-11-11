#!/bin/bash
# Shell completions for SEO Audit Tool
# Usage:
#   Bash: source completions.sh
#   Zsh:  source completions.sh

_seo_audit_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local opts="--origin= --sitemap= --compare= --compare-sitemap= --proceed --perf --save-html --screenshots --concurrency= --repo= --config= --init-config --open --verbose --heap-size= --ci= --json --exclude= --limit= --dry-run --preset= --sections= --checks= --webhook= --slack= --sites= --watch= --brand-logo= --brand-name= --generate-ci --validate-config --verify --llm --phase2 --no-phase2 --no-score --visual --no-visual --evidence --no-evidence --evidence-cap= --content-research --competitors= --version --help"

  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )

  # If completing a file path argument, fall back to file completion
  case "$cur" in
    --sitemap=*|--compare-sitemap=*|--config=*|--repo=*|--sites=*|--competitors=*)
      local prefix="${cur%%=*}="
      local path="${cur#*=}"
      COMPREPLY=( $(compgen -f -- "$path" | sed "s|^|$prefix|") )
      ;;
  esac
}

# Bash completion
if [ -n "$BASH_VERSION" ]; then
  complete -o nospace -F _seo_audit_completions node
fi

# Zsh completion (compatible mode)
if [ -n "$ZSH_VERSION" ]; then
  autoload -U +X bashcompinit && bashcompinit
  complete -o nospace -F _seo_audit_completions node
fi
