<?php
/**
 * AlcorFields closed field types.
 *
 * Every value an editor, the REST API or an import supplies passes through exactly one of these before it is
 * stored or rendered; the canonical form is what gets saved. The set is closed on purpose: there is no "raw HTML"
 * type, so no one, including an administrator, can store markup the template did not allow for.
 *
 *   text    plain text (escaped at render). Single line unless the field is element content.
 *   inline  inline rich text: a fixed tag allowlist; no styles, events or comments, and a class only when the
 *           template's own default used exactly that class on a link or span.
 *   url     a link target: same-page #anchor, root or relative path, http(s), mailto or tel.
 *   image   an image source: a relative or same-origin path to an allowed image file type.
 *   number  a whole number from 1 to 99999 (image width and height).
 *
 * Capability and role checks never widen this: an administrator's value is checked exactly like a client's.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'ALCOR_FIELDS_CLI' ) ) {
	exit;
}

/**
 * Validators and canonicalisers for the five field types.
 */
final class Alcor_Fields_Types {

	const KINDS = array( 'text', 'inline', 'url', 'image', 'number' );

	/**
	 * Inline tags and the only attributes each may carry.
	 */
	const INLINE_TAGS = array(
		'a'      => array( 'href', 'title', 'class' ),
		'abbr'   => array( 'title' ),
		'b'      => array(),
		'br'     => array(),
		'code'   => array(),
		'em'     => array(),
		'i'      => array(),
		'mark'   => array(),
		's'      => array(),
		'small'  => array(),
		'span'   => array( 'aria-hidden', 'class' ),
		'strong' => array(),
		'sub'    => array(),
		'sup'    => array(),
	);

	const IMAGE_EXT = '/\.(?:avif|gif|jpe?g|png|svg|webp)$/i';

	/**
	 * Counts the characters in a UTF-8 string. mbstring is optional on some hosts and CLI images.
	 *
	 * @param string $text UTF-8 text.
	 * @return int
	 */
	public static function length( $text ) {
		return function_exists( 'mb_strlen' ) ? mb_strlen( $text, 'UTF-8' ) : (int) preg_match_all( '/./su', $text );
	}

	/**
	 * Validates one value against a field rule and returns its canonical form.
	 *
	 * @param mixed                $value The submitted value.
	 * @param array                $rule  Field rule: kind, max (characters), required, multiline, classes, no_links.
	 * @param string               $path  Field path for error messages, such as "work.items[2].title".
	 * @param array<string, array> $env   Site facts: 'hosts' lists the hosts an absolute image URL may use.
	 * @return string The value in the form that is stored and rendered.
	 * @throws Alcor_Fields_Error When the value is not acceptable for the field.
	 */
	public static function canonical( $value, array $rule, $path, array $env = array() ) {
		if ( ! is_string( $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'must be text' );
		}
		if ( strlen( $value ) > 65536 ) {
			throw Alcor_Fields_Error::at( $path, 'is too large' );
		}
		$value = str_replace( array( "\r\n", "\r" ), "\n", $value );
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'contains control characters' );
		}
		if ( ! preg_match( '//u', $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'is not valid UTF-8' );
		}
		// A single-line field takes Enter as a space (an editor's textarea may offer a line break it cannot keep).
		if ( empty( $rule['multiline'] ) ) {
			$value = preg_replace( '/[ \t]*\n[ \t]*/', ' ', $value );
		}
		switch ( $rule['kind'] ) {
			case 'text':
				$out     = $value;
				$visible = $value;
				break;
			case 'inline':
				$out     = self::inline( $value, $path, $rule['classes'] ?? array(), ! empty( $rule['no_links'] ) );
				$visible = Alcor_Fields_Html::decode( strip_tags( $out ) );
				break;
			case 'url':
				$out     = self::url( trim( $value ), $path );
				$visible = $out;
				break;
			case 'image':
				$out     = self::image( trim( $value ), $path, $env );
				$visible = $out;
				break;
			case 'number':
				$out = trim( $value );
				if ( ! preg_match( '/^[1-9][0-9]{0,4}$/', $out ) ) {
					throw Alcor_Fields_Error::at( $path, 'must be a whole number from 1 to 99999' );
				}
				$visible = $out;
				break;
			default:
				throw Alcor_Fields_Error::at( $path, 'unknown field kind' );
		}
		$max = (int) ( $rule['max'] ?? 500 );
		if ( self::length( $visible ) > $max ) {
			throw Alcor_Fields_Error::at( $path, 'is longer than ' . $max . ' characters' );
		}
		if ( strlen( $out ) > 65536 ) {
			throw Alcor_Fields_Error::at( $path, 'is too large' );
		}
		if ( ! empty( $rule['required'] ) && '' === trim( $visible, " \t\n\u{00A0}" ) ) {
			throw Alcor_Fields_Error::at( $path, 'cannot be empty' );
		}
		return $out;
	}

	/**
	 * Re-emits inline rich text from its parse: allowed tags only, attributes rebuilt, text re-escaped.
	 *
	 * The output is rebuilt from the parse tree, never filtered from the input string, so nothing the parser did not
	 * understand can survive into the stored value.
	 *
	 * @param string   $value    Inline markup.
	 * @param string   $path     Field path for error messages.
	 * @param string[] $classes  Class values the field may keep.
	 * @param bool     $no_links True when the field already sits inside a link or button, where a browser would split a nested link.
	 * @return string The cleaned markup.
	 * @throws Alcor_Fields_Error On a disallowed tag, attribute, class or link.
	 */
	public static function inline( $value, $path, array $classes = array(), $no_links = false ) {
		$root = Alcor_Fields_Html::parse( $value, $path );
		return self::inline_children( $value, $root, $path, (bool) $no_links, $classes );
	}

	/**
	 * Lists the class values used on links and spans in authored inline markup (what that field may keep using).
	 *
	 * @param string $html Authored inline markup.
	 * @return string[] Sorted class values.
	 */
	public static function inline_classes( $html ) {
		$found = array();
		$walk  = static function ( Alcor_Fields_Node $node ) use ( &$walk, &$found ) {
			foreach ( $node->children as $child ) {
				if ( 'element' !== $child->type ) {
					continue;
				}
				$class = $child->attr( 'class' );
				if ( null !== $class ) {
					$found[ $class ] = true;
				}
				$walk( $child );
			}
		};
		$walk( Alcor_Fields_Html::parse( $html, 'classes' ) );
		$classes = array_keys( $found );
		sort( $classes );
		return $classes;
	}

	/**
	 * Rebuilds the children of a node as safe inline markup.
	 *
	 * @param string            $src     The markup the tree was parsed from.
	 * @param Alcor_Fields_Node $node    Node whose children are emitted.
	 * @param string            $path    Field path for error messages.
	 * @param bool              $in_link True inside a link, where another link is refused.
	 * @param string[]          $classes Class values the field may keep.
	 * @return string
	 * @throws Alcor_Fields_Error On a disallowed construct.
	 */
	private static function inline_children( $src, Alcor_Fields_Node $node, $path, $in_link, array $classes ) {
		$out = '';
		foreach ( $node->children as $child ) {
			if ( 'text' === $child->type ) {
				$out .= Alcor_Fields_Html::esc_text( Alcor_Fields_Html::decode( Alcor_Fields_Html::slice( $src, $child->start, $child->end ) ) );
				continue;
			}
			if ( 'element' !== $child->type ) {
				throw Alcor_Fields_Error::at( $path, 'comments and declarations are not allowed' );
			}
			$name = $child->name;
			if ( ! isset( self::INLINE_TAGS[ $name ] ) ) {
				throw Alcor_Fields_Error::at( $path, '<' . $name . '> is not allowed here' );
			}
			if ( 'a' === $name && $in_link ) {
				throw Alcor_Fields_Error::at( $path, 'this text is already a link or button, so it cannot contain another link' );
			}
			$attrs = '';
			foreach ( $child->attrs as $attr ) {
				if ( ! in_array( $attr['name'], self::INLINE_TAGS[ $name ], true ) ) {
					throw Alcor_Fields_Error::at( $path, 'attribute ' . $attr['name'] . ' is not allowed on <' . $name . '>' );
				}
				$v = (string) $attr['value'];
				if ( 'href' === $attr['name'] ) {
					$v = self::url( trim( $v ), $path );
				}
				if ( 'aria-hidden' === $attr['name'] && 'true' !== $v ) {
					throw Alcor_Fields_Error::at( $path, 'aria-hidden must be "true"' );
				}
				if ( 'class' === $attr['name'] && ! in_array( $v, $classes, true ) ) {
					throw Alcor_Fields_Error::at( $path, 'class "' . $v . '" is not one this field uses' );
				}
				$attrs .= ' ' . $attr['name'] . '="' . Alcor_Fields_Html::esc_attr( $v ) . '"';
			}
			if ( 'a' === $name && false === strpos( $attrs, ' href="' ) ) {
				throw Alcor_Fields_Error::at( $path, 'a link needs an href' );
			}
			if ( 'br' === $name ) {
				$out .= '<br' . $attrs . '>';
				continue;
			}
			$out .= '<' . $name . $attrs . '>' . self::inline_children( $src, $child, $path, $in_link || 'a' === $name, $classes ) . '</' . $name . '>';
		}
		return $out;
	}

	/**
	 * Validates a link target.
	 *
	 * Allowed: a same-page "#anchor", a root or relative path, and http(s), mailto and tel links. Everything else
	 * is refused, which is what keeps "javascript:" and "data:" links out of stored content.
	 *
	 * @param string $value Link target, already trimmed.
	 * @param string $path  Field path for error messages.
	 * @return string The accepted target, unchanged.
	 * @throws Alcor_Fields_Error When the target is empty, malformed or uses another scheme.
	 */
	public static function url( $value, $path ) {
		if ( '' === $value ) {
			throw Alcor_Fields_Error::at( $path, 'a link needs a target' );
		}
		if ( preg_match( '/[\x00-\x20\x7F<>"\'`\\\\]/', $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'link contains spaces or unsafe characters' );
		}
		if ( '#' === $value[0] ) {
			if ( ! preg_match( '/^#[A-Za-z][A-Za-z0-9_-]*$/', $value ) ) {
				throw Alcor_Fields_Error::at( $path, 'invalid page anchor' );
			}
			return $value;
		}
		if ( 0 === strpos( $value, '//' ) ) {
			throw Alcor_Fields_Error::at( $path, 'protocol-relative links are not allowed' );
		}
		if ( preg_match( '/^([A-Za-z][A-Za-z0-9+.-]*):/', $value, $m ) ) {
			$scheme = strtolower( $m[1] );
			if ( ! in_array( $scheme, array( 'http', 'https', 'mailto', 'tel' ), true ) ) {
				throw Alcor_Fields_Error::at( $path, 'unsafe link scheme ' . $scheme );
			}
			if ( in_array( $scheme, array( 'http', 'https' ), true ) && ! preg_match( '#^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?\#]|$)#i', $value ) ) {
				throw Alcor_Fields_Error::at( $path, 'invalid web address' );
			}
			if ( 'mailto' === $scheme && ! preg_match( '/^mailto:[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\?.*)?$/i', $value ) ) {
				throw Alcor_Fields_Error::at( $path, 'invalid email link' );
			}
			if ( 'tel' === $scheme && ! preg_match( '/^tel:\+?[0-9().-]{3,32}$/', $value ) ) {
				throw Alcor_Fields_Error::at( $path, 'invalid phone link' );
			}
			return $value;
		}
		if ( in_array( '..', explode( '/', (string) parse_url( $value, PHP_URL_PATH ) ), true ) ) {
			throw Alcor_Fields_Error::at( $path, 'link cannot climb directories' );
		}
		return $value;
	}

	/**
	 * Validates an image source.
	 *
	 * @param string               $value Image address, already trimmed.
	 * @param string               $path  Field path for error messages.
	 * @param array<string, array> $env   Site facts: 'hosts' lists the hosts an absolute image URL may use.
	 * @return string The accepted address, unchanged.
	 * @throws Alcor_Fields_Error When the file type is not an image, the path climbs directories, or the host is not this site.
	 */
	public static function image( $value, $path, array $env ) {
		if ( '' === $value ) {
			throw Alcor_Fields_Error::at( $path, 'an image is required' );
		}
		if ( preg_match( '/[\x00-\x20\x7F<>"\'`\\\\]/', $value ) ) {
			throw Alcor_Fields_Error::at( $path, 'image address contains unsafe characters' );
		}
		$url_path = (string) parse_url( $value, PHP_URL_PATH );
		if ( ! preg_match( self::IMAGE_EXT, $url_path ) ) {
			throw Alcor_Fields_Error::at( $path, 'image must be avif, gif, jpg, png, svg or webp' );
		}
		if ( in_array( '..', explode( '/', $url_path ), true ) ) {
			throw Alcor_Fields_Error::at( $path, 'image path cannot climb directories' );
		}
		if ( 0 === strpos( $value, '//' ) ) {
			throw Alcor_Fields_Error::at( $path, 'image must be on this site' );
		}
		if ( preg_match( '/^([A-Za-z][A-Za-z0-9+.-]*):/', $value, $m ) ) {
			if ( ! in_array( strtolower( $m[1] ), array( 'http', 'https' ), true ) ) {
				throw Alcor_Fields_Error::at( $path, 'image must be a web address on this site' );
			}
			$host  = strtolower( (string) parse_url( $value, PHP_URL_HOST ) );
			$hosts = array_map( 'strtolower', $env['hosts'] ?? array() );
			if ( '' === $host || ! in_array( $host, $hosts, true ) ) {
				throw Alcor_Fields_Error::at( $path, 'image must be on this site' );
			}
		}
		return $value;
	}
}
