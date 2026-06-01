# Home Manager module for cc (CanaryCode). Imported by flake.nix as
# `homeManagerModules.default`, curried with the flake's `self` so the default
# package resolves to this flake's release for the user's system.
#
# Usage (in a Home Manager config that has this flake as an input named `cc`):
#
#   imports = [ cc.homeManagerModules.default ];
#   programs.cc = {
#     enable = true;
#     # optional — when set, renders a read-only ~/.cc/config.json:
#     settings = {
#       model = "opus";
#       thinking = "off";
#     };
#   };
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.cc;
in
{
  options.programs.cc = {
    enable = lib.mkEnableOption "cc, a fast minimal terminal coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "cc.packages.\${system}.default";
      description = "The cc package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr (lib.types.attrsOf lib.types.anything);
      default = null;
      description = ''
        Declarative contents of ~/.cc/config.json. When set, the file is managed
        by Home Manager (read-only). When null (the default), the config file is
        left mutable and user-managed, as `cc` writes it itself.
      '';
      example = lib.literalExpression ''
        {
          model = "opus";
          thinking = "off";
          autoUpdate.enabled = false;
        }
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Self-update is already disabled by the package wrapper (CC_DISABLE_UPDATE=1);
    # only manage the config file when the user opts in with `settings`.
    home.file.".cc/config.json" = lib.mkIf (cfg.settings != null) {
      text = builtins.toJSON cfg.settings;
    };
  };
}
