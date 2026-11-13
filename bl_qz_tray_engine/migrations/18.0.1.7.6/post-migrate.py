# -*- coding: utf-8 -*-


def migrate(cr, version):
    del version
    cr.execute(
        """
        UPDATE pos_config
           SET qz_logo_scale_percent = LEAST(GREATEST(qz_logo_scale_percent, 50), 300)
         WHERE qz_logo_scale_percent IS NOT NULL
           AND qz_logo_scale_percent <> 0
           AND (qz_logo_scale_percent < 50 OR qz_logo_scale_percent > 300)
        """
    )
